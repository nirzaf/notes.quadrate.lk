import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const raw = match[2] ?? '';
    try {
      values[match[1]] = JSON.parse(raw);
    } catch {
      values[match[1]] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return values;
}

const { stdout } = await execFileAsync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], { cwd: root, maxBuffer: 2_000_000 });
const values = parseEnv(stdout);
const supabaseUrl = values.API_URL ?? values.SUPABASE_URL;
const publishableKey = values.PUBLISHABLE_KEY ?? values.ANON_KEY ?? values.SUPABASE_ANON_KEY;
const serviceRoleKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !publishableKey || !serviceRoleKey) throw new Error('Supabase status did not provide the required local URL and keys.');

const apiUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-api`;
const webEnv = [
  `VITE_SUPABASE_URL=${supabaseUrl}`,
  `VITE_SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
  `VITE_QNOTES_API_URL=${apiUrl}`,
  'VITE_ALLOW_INSECURE_LOOPBACK=true',
  '',
].join('\n');
const functionEnv = [
  `SUPABASE_URL=${supabaseUrl}`,
  `SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
  `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
  'QNOTES_ALLOWED_ORIGIN=http://127.0.0.1:5173,http://localhost:5173',
  'QNOTES_TOKEN_PEPPER=local-test-token-pepper-not-for-production',
  'QNOTES_INTERNAL_WORKER_SECRET=local-qnotes-worker-secret',
  'QNOTES_ENVIRONMENT=test',
  'QNOTES_FAKE_EMBEDDINGS=1',
  'QNOTES_EMBEDDING_MODE=synthetic-test-v1',
  'QNOTES_MAX_ATTACHMENT_BYTES=20971520',
  'QNOTES_EXPORT_MAX_BYTES=52428800',
  'QNOTES_CLIENT_IP_HEADER=x-forwarded-for',
  '',
].join('\n');
const localValues = { supabaseUrl, publishableKey, serviceRoleKey, apiUrl };
await mkdir(join(root, 'apps/web'), { recursive: true });
await mkdir(join(root, 'supabase/functions'), { recursive: true });
await mkdir(join(root, '.tmp'), { recursive: true });
await writeFile(join(root, 'apps/web/.env.local'), webEnv, { mode: 0o600 });
await writeFile(join(root, 'supabase/functions/.env.test'), functionEnv, { mode: 0o600 });
await writeFile(join(root, '.tmp/local-env.json'), `${JSON.stringify(localValues, null, 2)}\n`, { mode: 0o600 });
await Promise.all([
  chmod(join(root, 'apps/web/.env.local'), 0o600),
  chmod(join(root, 'supabase/functions/.env.test'), 0o600),
  chmod(join(root, '.tmp/local-env.json'), 0o600),
]);
console.log('Local environment files created without printing secret values.');
