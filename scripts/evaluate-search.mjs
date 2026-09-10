import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMetrics } from './search-evaluation-metrics.mjs';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const fixturePath = resolve(root, argument('--fixtures') ?? 'tests/search-evaluation-fixtures.json');
const inputPath = argument('--results');
const shouldSeed = process.argv.includes('--seed');
const metricUnit = argument('--metric-unit') ?? 'note';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function deterministicUuid(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function bodyData(body) {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
  return body.data;
}

async function localEnvironment() {
  const explicitApiUrl = argument('--url') ?? process.env.QNOTES_URL;
  const explicitToken = argument('--token') ?? process.env.QNOTES_TOKEN;
  let local = null;
  try {
    local = JSON.parse(await readFile(join(root, '.tmp/local-env.json'), 'utf8'));
  } catch {
    // The actionable error is emitted below.
  }
  const apiUrl = explicitApiUrl ?? local?.apiUrl ?? '';
  const supabaseUrl = local?.supabaseUrl ?? apiUrl.replace(/\/functions\/v1\/qnotes-api\/?$/, '');
  if (!supabaseUrl || !apiUrl || !isLocalUrl(supabaseUrl) || !isLocalUrl(apiUrl)) {
    throw new Error('Real evaluation requires a local Supabase URL. Run `pnpm exec supabase start && pnpm run local:env` first.');
  }
  return { ...local, supabaseUrl, apiUrl, token: explicitToken };
}

async function request(env, path, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${env.apiUrl}/api${path}`, { ...init, headers });
  const body = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function adminRequest(env, path, init = {}) {
  if (!env.serviceRoleKey) throw new Error('Local evaluation seeding requires serviceRoleKey in .tmp/local-env.json.');
  const headers = new Headers(init.headers);
  headers.set('apikey', env.serviceRoleKey);
  headers.set('Authorization', `Bearer ${env.serviceRoleKey}`);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`${env.supabaseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Supabase admin ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function findNote(env, token, slug) {
  try {
    return bodyData(await request(env, `/notes/${encodeURIComponent(slug)}?includeDeleted=true`, token));
  } catch (error) {
    if (String(error).includes('HTTP 404')) return null;
    throw error;
  }
}

async function signIn(env, email, password) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw new Error(`Local evaluation sign-in failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function ensureUser(env, email, password) {
  const listing = await adminRequest(env, '/auth/v1/admin/users?page=1&per_page=100');
  let user = listing.users?.find((candidate) => candidate.email === email);
  if (!user) user = await adminRequest(env, '/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
  try {
    return await signIn(env, email, password);
  } catch (error) {
    if (!user?.id) throw error;
    await adminRequest(env, `/auth/v1/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ password, email_confirm: true }) });
    return signIn(env, email, password);
  }
}

async function seedAttachment(env, token, note, spec) {
  const listed = bodyData(await request(env, `/notes/${encodeURIComponent(note.id)}/attachments`, token));
  const existing = Array.isArray(listed) ? listed.find((item) => item.originalFileName === spec.fileName || item.original_file_name === spec.fileName) : null;
  if (existing) return existing;
  const bytes = await readFile(resolve(root, spec.fixturePath));
  const requested = bodyData(await request(env, '/attachments/upload-url', token, { method: 'POST', body: JSON.stringify({ noteId: note.id, fileName: spec.fileName, mimeType: spec.mimeType, sizeBytes: bytes.byteLength }) }));
  const storage = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const upload = await storage.storage.from('note-attachments').uploadToSignedUrl(
    requested.path,
    requested.token,
    new Blob([bytes], { type: spec.mimeType }),
  );
  if (upload.error) throw new Error(`Attachment upload failed: ${upload.error.message}`);
  return bodyData(await request(env, `/attachments/${requested.attachment.id}/finalize`, token, { method: 'POST' }));
}

async function seedCorpus(env, fixture) {
  const token = await ensureUser(env, 'hermes-evaluation@qnotes.local', 'Qnotes-Evaluation-2026!');
  const notebookResponse = bodyData(await request(env, '/notebooks', token));
  const notebooks = new Map((notebookResponse.items ?? []).map((item) => [item.name, item.id]));
  for (const name of new Set(fixture.corpus.map((item) => item.notebook).filter(Boolean))) {
    if (!notebooks.has(name)) {
      const created = bodyData(await request(env, '/notebooks', token, { method: 'POST', body: JSON.stringify({ name }) }));
      notebooks.set(name, created.id);
    }
  }
  const notes = new Map();
  for (const item of fixture.corpus) {
    const existing = item.key === 'deleted-note' ? await findNote(env, token, item.slug) : null;
    const note = existing ?? bodyData(await request(env, '/notes', token, {
      method: 'POST',
      body: JSON.stringify({
        title: item.title,
        slug: item.slug,
        contentMarkdown: item.contentMarkdown,
        tags: item.tags,
        ...(item.notebook ? { notebookId: notebooks.get(item.notebook) } : {}),
        dedupeKey: `hermes-evaluation:${item.key}`,
        deviceId: deterministicUuid(`hermes-evaluation:device:${item.key}`),
        mutationId: deterministicUuid(`hermes-evaluation:create:${item.key}`),
      }),
    }));
    notes.set(item.key, note);
    if (item.key === 'deleted-note' && !note.deletedAt) {
      await request(env, `/notes/${note.id}`, token, { method: 'DELETE', body: JSON.stringify({ expectedVersion: note.version, deviceId: deterministicUuid('hermes-evaluation:delete-device'), mutationId: deterministicUuid('hermes-evaluation:delete') }) });
    }
  }
  for (const item of fixture.corpus.filter((candidate) => candidate.attachment)) await seedAttachment(env, token, notes.get(item.key), item.attachment);
  const otherToken = await ensureUser(env, 'hermes-evaluation-other@qnotes.local', 'Qnotes-Evaluation-Other-2026!');
  await request(env, '/notes', otherToken, { method: 'POST', body: JSON.stringify({ title: 'Owner Isolation Marker', slug: 'owner-isolation-marker', contentMarkdown: '# Owner isolation marker', tags: ['evaluation'], dedupeKey: 'hermes-evaluation:cross-owner', deviceId: deterministicUuid('hermes-evaluation:other-device'), mutationId: deterministicUuid('hermes-evaluation:other-create') }) });
  const envText = await readFile(join(root, 'supabase/functions/.env.test'), 'utf8').catch(() => '');
  const workerSecret = envText.split(/\r?\n/).find((line) => line.startsWith('QNOTES_INTERNAL_WORKER_SECRET='))?.slice('QNOTES_INTERNAL_WORKER_SECRET='.length);
  if (workerSecret) {
    for (const workerName of ['embedding-worker', 'attachment-worker']) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const worker = await fetch(`${env.supabaseUrl}/functions/v1/${workerName}`, { method: 'POST', headers: { 'x-qnotes-worker-secret': workerSecret, 'Content-Type': 'application/json' }, body: '{}' });
        if (!worker.ok) break;
        const result = await worker.json().catch(() => null);
        if (!result?.data?.completed) break;
      }
    }
  }
  return token;
}

async function main() {
  if (inputPath) {
    const predictions = JSON.parse(await readFile(resolve(root, inputPath), 'utf8'));
    console.log(JSON.stringify({ mode: 'offline', ...calculateMetrics(fixture.queries, predictions, { metricUnit }) }, null, 2));
    return;
  }
  const env = await localEnvironment();
  let token = env.token;
  if (shouldSeed) token = await seedCorpus(env, fixture);
  if (!token) token = await signIn(env, 'hermes-evaluation@qnotes.local', 'Qnotes-Evaluation-2026!');
  const notebooks = bodyData(await request(env, '/notebooks', token));
  const notebookIds = new Map((notebooks.items ?? []).map((item) => [item.name, item.id]));
  const predictions = {};
  for (const query of fixture.queries) {
    const filters = { ...(query.filters ?? {}) };
    if (Array.isArray(filters.notebookIds)) filters.notebookIds = filters.notebookIds.map((value) => value === '$Operations' ? notebookIds.get('Operations') : value).filter(Boolean);
    const data = bodyData(await request(env, '/search', token, { method: 'POST', body: JSON.stringify({ query: query.query, mode: query.mode, limit: 10, maxPerNote: 2, filters }) }));
    predictions[query.id] = (data.items ?? []).map((item) => ({ key: fixture.corpus.find((candidate) => candidate.slug === item.noteSlug)?.key ?? null, noteId: item.noteId, documentId: item.documentId ?? item.id }));
  }
  console.log(JSON.stringify({ mode: 'api', ...calculateMetrics(fixture.queries, predictions, { metricUnit }) }, null, 2));
}

await main();
