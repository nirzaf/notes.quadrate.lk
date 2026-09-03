import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

if (!process.argv.includes('--local-benchmark')) throw new Error('Refusing benchmark seeding without the explicit --local-benchmark flag.');
const size = Number(argument('--size', '1000'));
if (!Number.isSafeInteger(size) || size < 1 || size > 100000) throw new Error('--size must be an integer from 1 to 100000.');

let local;
try {
  local = JSON.parse(await readFile(join(root, '.tmp/local-env.json'), 'utf8'));
} catch {
  throw new Error('Local benchmark seeding requires `.tmp/local-env.json`. Run `pnpm exec supabase start && pnpm run local:env` first.');
}
const url = new URL(local.supabaseUrl);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Refusing to seed a non-local Supabase URL.');

const email = 'qnotes-benchmark@qnotes.local';
const password = 'Qnotes-Benchmark-2026!';
const adminHeaders = { apikey: local.serviceRoleKey, Authorization: `Bearer ${local.serviceRoleKey}`, 'Content-Type': 'application/json' };

async function adminRequest(path, init = {}) {
  const response = await fetch(`${local.supabaseUrl}${path}`, { ...init, headers: { ...adminHeaders, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Supabase admin ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const users = await adminRequest('/auth/v1/admin/users?page=1&per_page=100');
let user = users.users?.find((candidate) => candidate.email === email);
if (!user) user = await adminRequest('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
try {
  const signIn = await fetch(`${local.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: local.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!signIn.ok) throw new Error('benchmark password rejected');
} catch {
  await adminRequest(`/auth/v1/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ password, email_confirm: true }) });
}

const sql = `
do $$
declare
  benchmark_owner uuid;
begin
  select id into benchmark_owner from auth.users where email = '${email}';
  if benchmark_owner is null then raise exception 'benchmark owner is missing'; end if;

  delete from notesdb.search_documents where owner_id = benchmark_owner and source_key like 'benchmark:%';
  delete from notesdb.notes where owner_id = benchmark_owner and slug like 'benchmark-%';

  insert into notesdb.notes (
    id, owner_id, slug, title, content_markdown, content_plain, tags,
    version, last_mutation_id, updated_by_device_id
  )
  select
    (md5(benchmark_owner::text || ':note:' || n::text))::uuid,
    benchmark_owner,
    'benchmark-' || n::text,
    'Benchmark Note ' || n::text,
    '# Benchmark Note ' || n::text || E'\\n\\nRollback deployment token rotation and SQL diagnostics corpus row ' || n::text || '.',
    'Benchmark Note ' || n::text || ' Rollback deployment token rotation and SQL diagnostics corpus row ' || n::text || '.',
    case when n % 3 = 0 then array['benchmark', 'rollback']::text[] else array['benchmark']::text[] end,
    1,
    (md5(benchmark_owner::text || ':mutation:' || n::text))::uuid,
    (md5(benchmark_owner::text || ':device:' || n::text))::uuid
  from generate_series(1, ${size}) as series(n);

  insert into notesdb.search_documents (
    owner_id, note_id, source_type, source_key, source_title, heading_path,
    content, content_hash, position, embedding, embedding_status,
    embedding_model, embedding_model_version, embedding_input_hash
  )
  select
    benchmark_owner,
    (md5(benchmark_owner::text || ':note:' || n::text))::uuid,
    'note_chunk',
    'benchmark:' || n::text,
    'Benchmark Note ' || n::text,
    null,
    'Rollback deployment token rotation and SQL diagnostics corpus row ' || n::text || '.',
    encode(digest('Rollback deployment token rotation and SQL diagnostics corpus row ' || n::text || '.', 'sha256'), 'hex'),
    0,
    ('[' || cos(n::double precision)::text || ',' || sin(n::double precision)::text || ',' || repeat('0,', 381) || '0]')::extensions.vector,
    'ready',
    'gte-small',
    'v2',
    public.qnotes_embedding_input_hash('Benchmark Note ' || n::text, null, 'Rollback deployment token rotation and SQL diagnostics corpus row ' || n::text || '.')
  from generate_series(1, ${size}) as series(n);
end $$;

select json_build_object(
  'ownerId', (select id from auth.users where email = '${email}'),
  'searchDocuments', (select count(*) from notesdb.search_documents where owner_id = (select id from auth.users where email = '${email}') and source_key like 'benchmark:%'),
  'notes', (select count(*) from notesdb.notes where owner_id = (select id from auth.users where email = '${email}') and slug like 'benchmark-%')
) as benchmark_counts;
`;
const { stdout } = await execFileAsync('pnpm', ['exec', 'supabase', 'db', 'query', '--local', sql], { cwd: root, maxBuffer: 2_000_000 });
const match = stdout.match(/\{\s*"ownerId"[\s\S]*?\}/);
if (!match) throw new Error(`Unable to verify benchmark row counts. Supabase output was: ${stdout}`);
const counts = JSON.parse(match[0]);
if (Number(counts.searchDocuments) !== size || Number(counts.notes) !== size) throw new Error(`Benchmark count verification failed: expected ${size}, got ${JSON.stringify(counts)}.`);
console.log(JSON.stringify({ localBenchmark: true, corpusSize: size, ...counts }));
