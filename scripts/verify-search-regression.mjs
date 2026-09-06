import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMetrics } from './search-evaluation-metrics.mjs';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modes = ['keyword', 'semantic', 'hybrid'];
const fixturePath = resolve(root, argument('--fixtures', 'tests/search-evaluation-fixtures.json'));
const baselinePath = resolve(root, argument('--baseline', 'tests/search-evaluation-baseline.json'));
const shouldSeed = process.argv.includes('--seed');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function bodyData(body, label) {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error(`${label} returned an invalid success envelope.`);
  return body.data;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function localEnvironment() {
  let local = {};
  try {
    local = await readJson(join(root, '.tmp/local-env.json'));
  } catch {
    // Explicit URL and token arguments are sufficient for a non-seeding run.
  }
  const apiUrl = (argument('--url') ?? process.env.QNOTES_URL ?? local.apiUrl ?? '').replace(/\/+$/, '');
  const supabaseUrl = local.supabaseUrl ?? apiUrl.replace(/\/functions\/v1\/qnotes-api\/?$/, '');
  if (!apiUrl || !supabaseUrl || !isLocalUrl(apiUrl) || !isLocalUrl(supabaseUrl)) {
    throw new Error('Search regression checks require a local Supabase URL. Run `pnpm exec supabase start && pnpm run local:env` first.');
  }
  return { ...local, apiUrl, supabaseUrl, token: argument('--token') ?? process.env.QNOTES_TOKEN };
}

async function signIn(env) {
  if (env.token) return env.token;
  if (!env.publishableKey) throw new Error('Search regression checks need QNOTES_TOKEN or the local publishable key from `pnpm run local:env`.');
  const response = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hermes-evaluation@qnotes.local', password: 'Qnotes-Evaluation-2026!' }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw new Error(`Local evaluation sign-in failed with HTTP ${response.status}.`);
  return body.access_token;
}

async function request(env, token, path, init = {}) {
  const started = performance.now();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${env.apiUrl}/api${path}`, { ...init, headers });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned malformed JSON with HTTP ${response.status}.`);
  }
  const latencyMs = performance.now() - started;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return { body, latencyMs };
}

function resolveFilters(filters, notebookIds) {
  const resolved = { ...(filters ?? {}) };
  if (Array.isArray(resolved.notebookIds)) {
    resolved.notebookIds = resolved.notebookIds.map((value) => {
      if (value !== '$Operations') return value;
      const notebookId = notebookIds.get('Operations');
      if (!notebookId) throw new Error('The Operations notebook is missing from the seeded evaluation corpus.');
      return notebookId;
    });
  }
  return resolved;
}

function resultKey(item, corpusBySlug) {
  return corpusBySlug.get(item.noteSlug)?.key ?? item.key ?? null;
}

function prediction(item, corpusBySlug) {
  return {
    key: resultKey(item, corpusBySlug),
    noteId: item.noteId ?? null,
    documentId: item.documentId ?? item.id ?? null,
  };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

function qualityMetrics(queries, predictions) {
  const metrics = calculateMetrics(queries, predictions, { metricUnit: 'note' });
  return {
    recallAt5: metrics.recallAt5,
    mrrAt10: metrics.mrrAt10,
    ndcgAt10: metrics.ndcgAt10,
  };
}

async function runStableEvaluator(env, token) {
  const args = [join(root, 'scripts/evaluate-search.mjs'), '--fixtures', fixturePath, '--url', env.apiUrl, '--token', token];
  if (shouldSeed) args.push('--seed');
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: root, maxBuffer: 4_000_000 });
  return JSON.parse(stdout.trim());
}

async function main() {
  const fixtureText = await readFile(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureText);
  const baseline = await readJson(baselinePath);
  if (baseline.fixtureSha256 !== sha256(fixtureText)) {
    throw new Error(`Search regression baseline is stale for ${fixturePath}. Re-run the evaluator and review the new baseline before updating it.`);
  }

  const env = await localEnvironment();
  const token = await signIn(env);
  const stable = await runStableEvaluator(env, token);
  const corpusBySlug = new Map(fixture.corpus.map((item) => [item.slug, item]));
  const notebookResponse = bodyData((await request(env, token, '/notebooks')).body, 'Notebook listing');
  const notebookIds = new Map((notebookResponse.items ?? []).map((item) => [item.name, item.id]));
  const queries = fixture.queries.map((query) => ({ ...query, filters: resolveFilters(query.filters, notebookIds) }));
  const predictions = Object.fromEntries(modes.map((mode) => [mode, {}]));
  const rawResults = Object.fromEntries(modes.map((mode) => [mode, {}]));
  const searchLatencies = Object.fromEntries(modes.map((mode) => [mode, []]));

  for (const mode of modes) {
    for (const query of queries) {
      const response = await request(env, token, '/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.query, mode, limit: 10, maxPerNote: 2, filters: query.filters ?? {} }),
      });
      const data = bodyData(response.body, 'Search response');
      if (!Array.isArray(data.items)) throw new Error(`Search response for ${mode}/${query.id} did not contain items.`);
      rawResults[mode][query.id] = data.items;
      predictions[mode][query.id] = data.items.map((item) => prediction(item, corpusBySlug));
      searchLatencies[mode].push(response.latencyMs);
    }
  }

  const quality = Object.fromEntries(modes.map((mode) => [mode, qualityMetrics(queries, predictions[mode])]));
  const contextChecks = [];
  const contextLatencies = [];
  for (const query of queries.filter((candidate) => Array.isArray(candidate.relevant) && candidate.relevant.length > 0)) {
    const relevant = new Set(query.relevant);
    const candidate = (rawResults.hybrid[query.id] ?? []).find((item) => relevant.has(resultKey(item, corpusBySlug)));
    if (!candidate) {
      contextChecks.push({ queryId: query.id, useful: false, reason: 'hybrid retrieval returned no relevant result' });
      continue;
    }
    const documentId = candidate.documentId ?? candidate.id;
    if (typeof documentId !== 'string' || !documentId) {
      contextChecks.push({ queryId: query.id, useful: false, reason: 'result did not identify a document' });
      continue;
    }
    try {
      const response = await request(env, token, `/search/documents/${encodeURIComponent(documentId)}/context?before=1&after=1&maxTokens=1200`);
      const context = bodyData(response.body, 'Context response');
      const useful = context
        && context.noteId === candidate.noteId
        && context.documentId === documentId
        && typeof context.content === 'string'
        && context.content.trim().length > 0
        && typeof context.sourceType === 'string';
      contextChecks.push({ queryId: query.id, useful: Boolean(useful), noteIdMatches: context?.noteId === candidate.noteId, documentIdMatches: context?.documentId === documentId });
      contextLatencies.push(response.latencyMs);
    } catch (error) {
      contextChecks.push({ queryId: query.id, useful: false, reason: String(error) });
    }
  }

  const context = {
    checks: contextChecks.length,
    useful: contextChecks.filter((check) => check.useful).length,
    usefulnessRate: contextChecks.length ? contextChecks.filter((check) => check.useful).length / contextChecks.length : 0,
    failures: contextChecks.filter((check) => !check.useful),
  };
  const latency = {
    searchP95Ms: Object.fromEntries(modes.map((mode) => [mode, percentile(searchLatencies[mode], 0.95)])),
    contextP95Ms: percentile(contextLatencies, 0.95),
  };

  const failures = [];
  for (const [mode, metrics] of Object.entries(quality)) {
    for (const [metric, actual] of Object.entries(metrics)) {
      const minimum = baseline.quality?.[mode]?.[metric];
      if (typeof minimum === 'number' && actual < minimum) failures.push(`${mode}.${metric}=${actual.toFixed(4)} is below baseline minimum ${minimum.toFixed(4)}`);
    }
  }
  for (const [metric, actual] of Object.entries({ recallAt5: stable.recallAt5, mrrAt10: stable.mrrAt10, ndcgAt10: stable.ndcgAt10 })) {
    const minimum = baseline.stableEvaluator?.[metric];
    if (typeof minimum === 'number' && actual < minimum) failures.push(`stableEvaluator.${metric}=${actual.toFixed(4)} is below baseline minimum ${minimum.toFixed(4)}`);
  }
  if (context.usefulnessRate < Number(baseline.context?.minimumUsefulnessRate ?? 0)) {
    failures.push(`context.usefulnessRate=${context.usefulnessRate.toFixed(4)} is below baseline minimum ${Number(baseline.context.minimumUsefulnessRate).toFixed(4)}`);
  }
  for (const mode of modes) {
    const maximum = baseline.latency?.searchP95Ms?.[mode];
    if (typeof maximum === 'number' && latency.searchP95Ms[mode] > maximum) failures.push(`${mode}.searchP95Ms=${latency.searchP95Ms[mode].toFixed(1)} exceeds baseline cap ${maximum.toFixed(1)}`);
  }
  const contextMaximum = baseline.latency?.contextP95Ms;
  if (typeof contextMaximum === 'number' && latency.contextP95Ms > contextMaximum) failures.push(`context.contextP95Ms=${latency.contextP95Ms.toFixed(1)} exceeds baseline cap ${contextMaximum.toFixed(1)}`);

  const report = {
    mode: 'local-regression',
    fixture: fixturePath.replace(`${root}/`, ''),
    baseline: baselinePath.replace(`${root}/`, ''),
    stableEvaluator: { recallAt5: stable.recallAt5, mrrAt10: stable.mrrAt10, ndcgAt10: stable.ndcgAt10 },
    quality,
    context,
    latency,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`Search regression guard failed with ${failures.length} regression(s).`);
    process.exitCode = 1;
  } else {
    console.error('Search regression guard passed.');
  }
}

await main();
