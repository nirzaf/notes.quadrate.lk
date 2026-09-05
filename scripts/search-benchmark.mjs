import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BenchmarkBodyParseError, readJsonBody } from './search-benchmark-utils.mjs';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

if (!process.argv.includes('--local-benchmark')) throw new Error('Refusing benchmark measurements without the explicit --local-benchmark flag.');
const sizes = argument('--sizes', '1000,10000,100000').split(',').map((value) => Number(value));
if (!sizes.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 100000)) throw new Error('--sizes must contain integers from 1 to 100000.');
const iterations = Number(argument('--iterations', '10'));
const warmups = Number(argument('--warmups', '2'));
if (!Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(warmups) || warmups < 0) throw new Error('--iterations and --warmups must be non-negative safe integers, with at least one iteration.');
const queries = argument('--queries', 'rollback production,token rotation,sql diagnostics').split(',').map((value) => value.trim()).filter(Boolean);

let local;
try {
  local = JSON.parse(await readFile(join(root, '.tmp/local-env.json'), 'utf8'));
} catch {
  throw new Error('Local benchmark requires `.tmp/local-env.json`. Run `pnpm exec supabase start && pnpm run local:env` first.');
}
const localUrl = new URL(local.supabaseUrl);
if (localUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(localUrl.hostname)) throw new Error('Refusing to benchmark a non-local Supabase URL.');
const apiUrl = argument('--url', process.env.QNOTES_URL ?? local.apiUrl).replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/.*)?$/.test(apiUrl)) throw new Error('Refusing to benchmark a non-local API URL.');

async function signIn() {
  const response = await fetch(`${local.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: local.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qnotes-benchmark@qnotes.local', password: 'Qnotes-Benchmark-2026!' }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw new Error(`Benchmark sign-in failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function runSeeder(size) {
  const { stdout } = await execFileAsync('node', [join(root, 'scripts/seed-search-benchmark.mjs'), '--local-benchmark', '--size', String(size)], { cwd: root, maxBuffer: 2_000_000 });
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('Benchmark seeder returned no verification output.');
  return JSON.parse(line);
}

async function search(token, query, mode) {
  const started = performance.now();
  try {
    const response = await fetch(`${apiUrl}/api/search`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, mode, limit: 10, maxPerNote: 1, filters: {} }) });
    const { body, bytes } = await readJsonBody(response, 'Search response');
    return { latencyMs: performance.now() - started, bytes, ok: response.ok, status: response.status, body };
  } catch (error) {
    if (error instanceof BenchmarkBodyParseError) throw error;
    return { latencyMs: performance.now() - started, bytes: 0, ok: false, error: String(error) };
  }
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

function summarize(samples) {
  const latencies = samples.map((sample) => sample.latencyMs);
  const payloads = samples.map((sample) => sample.bytes);
  return {
    samples: samples.length,
    errors: samples.filter((sample) => !sample.ok).length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.length ? Math.max(...latencies) : null,
    payloadBytesP50: percentile(payloads, 0.5),
    payloadBytesP95: percentile(payloads, 0.95),
  };
}

async function collect(token, mode, kind) {
  const samples = [];
  for (const query of queries) {
    for (let index = 0; index < warmups; index += 1) await search(token, kind === 'uncached' ? `${query} warmup ${index}` : query, mode);
    for (let index = 0; index < iterations; index += 1) {
      const value = kind === 'uncached' ? `${query} cache-miss-${index}-${Date.now()}` : query;
      samples.push(await search(token, value, mode));
    }
  }
  return summarize(samples);
}

function fakeEmbedding(value) {
  const seed = Buffer.from(value, 'utf8');
  const bytes = [];
  for (let round = 0; bytes.length < 384; round += 1) {
    const input = Buffer.alloc(seed.length + 4);
    seed.copy(input);
    input.writeUInt32BE(round, seed.length);
    bytes.push(...createHash('sha256').update(input).digest());
  }
  const vector = bytes.slice(0, 384).map((byte) => byte / 127.5 - 1);
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / magnitude);
}

async function dbQuery(sql) {
  const { stdout } = await execFileAsync('pnpm', ['exec', 'supabase', 'db', 'query', '--local', '--output-format', 'json', sql], { cwd: root, maxBuffer: 2_000_000 });
  return stdout;
}

function jsonObject(output, key) {
  const marker = key ? output.indexOf(`"${key}"`) : -1;
  const start = marker >= 0 ? output.lastIndexOf('{', marker) : output.lastIndexOf('{');
  const end = output.indexOf('}', marker >= 0 ? marker : start);
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(output.slice(start, end + 1)); } catch { return null; }
}

async function runtimeInfo(ownerId, size) {
  const output = await dbQuery(`select json_build_object('postgresVersion', current_setting('server_version'), 'pgvectorVersion', (select extversion from pg_extension where extname = 'vector'), 'searchDocuments', (select count(*) from notesdb.search_documents where owner_id = '${ownerId}' and source_key like 'benchmark:%')) as benchmark_runtime;`);
  const parsed = jsonObject(output, 'postgresVersion');
  if (!parsed || Number(parsed.searchDocuments) !== size) throw new Error(`Benchmark runtime count verification failed: ${output}`);
  return parsed;
}

async function exactIds(ownerId, query) {
  const vector = `[${fakeEmbedding(query).map((item) => item.toFixed(8)).join(',')}]`;
  const output = await dbQuery(`select id from notesdb.search_documents where owner_id = '${ownerId}' and embedding_status = 'ready' and embedding_model = 'gte-small' and embedding_model_version = 'v2' and embedding is not null order by embedding <#> '${vector}'::extensions.vector, id limit 10;`);
  const ids = [...output.matchAll(/"id"\s*:\s*"([0-9a-f-]{36})"/gi)].map((match) => match[1]);
  return ids;
}

async function annRecall(token, ownerId) {
  const values = [];
  for (const query of queries) {
    const response = await search(token, query, 'semantic');
    if (!response.ok) throw new Error(`ANN search failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    if (!response.body || typeof response.body !== 'object' || !response.body.data || typeof response.body.data !== 'object' || !Array.isArray(response.body.data.items)) {
      throw new Error('ANN search returned a malformed success envelope.');
    }
    const approximate = response.body.data.items.map((item) => item.documentId ?? item.id).filter(Boolean);
    const exact = await exactIds(ownerId, query);
    if (exact.length) values.push(approximate.filter((id) => exact.includes(id)).length / exact.length);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

let token = argument('--token', process.env.QNOTES_TOKEN);
const reports = [];
for (const size of sizes) {
  const seeded = await runSeeder(size);
  if (!token) token = await signIn();
  const ownerId = seeded.ownerId;
  const runtime = await runtimeInfo(ownerId, size);
  const measurements = {};
  for (const mode of ['keyword', 'semantic', 'hybrid']) {
    measurements[`${mode}-cached`] = await collect(token, mode, 'cached');
    measurements[`${mode}-uncached`] = mode === 'keyword' ? null : await collect(token, mode, 'uncached');
  }
  reports.push({ corpusSize: size, verifiedSearchDocuments: Number(seeded.searchDocuments), queryCount: queries.length, iterationsPerQuery: iterations, warmupsPerQuery: warmups, measurements, annRecallAt10: await annRecall(token, ownerId), runtime });
}
console.log(JSON.stringify({ localBenchmark: true, node: process.version, platform: process.platform, arch: process.arch, reports }, null, 2));
