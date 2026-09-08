import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const minimumNode = [18, 0, 0];
const minimumDeno = [2, 9, 6];
const fallbackDenoVersion = '2.9.6';
const requiredPnpm = '12.1.0';
const localHosts = new Set(['localhost', '127.0.0.1']);

export const LOCAL_VERIFY_STAGES = [
  { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
  { name: 'unit tests', command: 'pnpm', args: ['run', 'test:unit'] },
  { name: 'Edge tests', command: 'pnpm', args: ['run', 'test:edge'] },
  { name: 'build', command: 'pnpm', args: ['run', 'build'] },
  { name: 'generated Edge parity', command: 'pnpm', args: ['run', 'verify:edge-shared'] },
  { name: 'database tests', command: 'pnpm', args: ['exec', 'supabase', 'test', 'db'] },
  { name: 'browser release smoke', command: 'pnpm', args: ['run', 'test:e2e:smoke'] },
];

function versionParts(value, label) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not parse the ${label} version.`);
  return match.slice(1).map(Number);
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function assertLocalUrl(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'http:') throw new Error(`${label} must use http:// for local verification.`);
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
  if (!localHosts.has(url.hostname)) throw new Error(`${label} must target localhost or 127.0.0.1.`);
  return url.href.replace(/\/+$/, '');
}

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function readRequired(path, label) {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    throw new Error(`${label} is missing. Run the documented one-time local setup; this gate will not create or overwrite it.`);
  }
}

function normalizedTarget(value, label) {
  return assertLocalUrl(value, label);
}

export function assertMatchingTarget(actual, expected, label) {
  if (normalizedTarget(actual, label) !== normalizedTarget(expected, `${label} expected target`)) {
    throw new Error(`${label} does not match the local Supabase target.`);
  }
}

async function readLocalTargets() {
  const web = parseDotenv(await readRequired('apps/web/.env.local', 'apps/web/.env.local'));
  const functions = parseDotenv(await readRequired('supabase/functions/.env.test', 'supabase/functions/.env.test'));
  let local;
  try {
    local = JSON.parse(await readRequired('.tmp/local-env.json', '.tmp/local-env.json'));
  } catch (error) {
    if (error.message.includes('missing')) throw error;
    throw new Error('.tmp/local-env.json is not valid JSON. Re-run the documented local setup manually.');
  }
  if (!local || typeof local !== 'object' || Array.isArray(local)) {
    throw new Error('.tmp/local-env.json must contain the local environment object created by `pnpm run local:env`.');
  }

  const localSupabaseUrl = normalizedTarget(local.supabaseUrl, '.tmp/local-env.json supabaseUrl');
  const localApiUrl = normalizedTarget(local.apiUrl, '.tmp/local-env.json apiUrl');
  const expectedApiUrl = `${localSupabaseUrl}/functions/v1/qnotes-api`;
  assertMatchingTarget(localApiUrl, expectedApiUrl, '.tmp/local-env.json apiUrl');
  assertMatchingTarget(web.VITE_SUPABASE_URL, localSupabaseUrl, 'VITE_SUPABASE_URL');
  assertMatchingTarget(web.VITE_QNOTES_API_URL, localApiUrl, 'VITE_QNOTES_API_URL');
  assertMatchingTarget(functions.SUPABASE_URL, localSupabaseUrl, 'SUPABASE_URL');

  for (const [name, value] of Object.entries({
    'local publishable key': local.publishableKey,
    'local service-role key': local.serviceRoleKey,
    'VITE_SUPABASE_PUBLISHABLE_KEY': web.VITE_SUPABASE_PUBLISHABLE_KEY,
    'SUPABASE_PUBLISHABLE_KEY': functions.SUPABASE_PUBLISHABLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY': functions.SUPABASE_SERVICE_ROLE_KEY,
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is missing from the local environment setup.`);
  }

  const origins = String(functions.QNOTES_ALLOWED_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('QNOTES_ALLOWED_ORIGIN is missing from supabase/functions/.env.test.');
  origins.forEach((origin, index) => normalizedTarget(origin, `QNOTES_ALLOWED_ORIGIN entry ${index + 1}`));

  const inheritedTargets = {
    QNOTES_URL: localApiUrl,
    SUPABASE_URL: localSupabaseUrl,
    VITE_SUPABASE_URL: localSupabaseUrl,
    VITE_QNOTES_API_URL: localApiUrl,
  };
  for (const [name, expected] of Object.entries(inheritedTargets)) {
    if (process.env[name]) assertMatchingTarget(process.env[name], expected, `inherited ${name}`);
  }
  if (process.env.QNOTES_E2E_EXTERNAL_API && !['0', '1'].includes(process.env.QNOTES_E2E_EXTERNAL_API)) {
    throw new Error('QNOTES_E2E_EXTERNAL_API must be 0 or 1.');
  }

  return { localSupabaseUrl, localApiUrl };
}

async function checkFile(path) {
  try {
    await access(join(root, path));
  } catch {
    throw new Error(`Required dependency or configuration file is missing: ${path}.`);
  }
}

function commandSucceeds(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolveResult(code === 0));
  });
}

async function checkVersions() {
  const node = versionParts(process.versions.node, 'Node.js');
  if (!atLeast(node, minimumNode)) throw new Error('Node.js 18.0.0 or newer is required.');

  const packageManager = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager;
  const packageManagerMatch = String(packageManager).match(/^pnpm@(\d+\.\d+\.\d+)$/);
  if (!packageManagerMatch) throw new Error('package.json must declare a pinned pnpm version.');
  const pnpm = await commandOutput('pnpm', ['--version'], 'pnpm');
  if (pnpm.trim() !== packageManagerMatch[1] || pnpm.trim() !== requiredPnpm) {
    throw new Error(`pnpm ${requiredPnpm} is required by package.json.`);
  }

  const deno = await denoVersionOutput();
  const denoVersion = versionParts(deno, 'Deno');
  if (!atLeast(denoVersion, minimumDeno)) throw new Error('Deno 2.9.6 or newer is required for the checked-in Edge tests.');
}

async function denoVersionOutput() {
  try {
    return await commandOutput('deno', ['--version'], 'Deno');
  } catch (error) {
    if (!String(error?.message ?? '').includes('Deno is required on PATH.')) throw error;
    return commandOutput('pnpm', ['dlx', '--yes', `deno@${fallbackDenoVersion}`, '--version'], 'Deno fallback');
  }
}

function commandOutput(command, args, label) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error(`${label} is required on PATH.`));
      else reject(error);
    });
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`${label} could not report its version.`));
      else resolveOutput(stdout);
    });
  });
}

async function checkDependencies() {
  for (const path of [
    'node_modules',
    'node_modules/.bin/supabase',
    'node_modules/.bin/playwright',
    'node_modules/@playwright/test',
    'node_modules/typescript',
    'supabase/functions/deno.json',
    'supabase/functions/deno.lock',
    'tests/e2e/release-smoke.spec.ts',
    'playwright.config.ts',
    'playwright.smoke.config.ts',
  ]) await checkFile(path);
  for (const path of ['apps/web/.env.local', 'supabase/functions/.env.test', '.tmp/local-env.json']) {
    if (!await commandSucceeds('git', ['check-ignore', '--no-index', '--quiet', path])) {
      throw new Error(`Required local file is not ignored by Git: ${path}. Refusing to use it in the verification gate.`);
    }
  }
}

async function checkSupabase(localTargets) {
  const output = await commandOutput(join(root, 'node_modules/.bin/supabase'), ['status', '-o', 'env'], 'local Supabase CLI').catch(() => {
    throw new Error('Local Supabase is unavailable. Start Docker and run `pnpm exec supabase start`; the gate does not start, reset, or mutate it.');
  });
  const values = parseDotenv(output);
  const statusUrl = values.API_URL ?? values.SUPABASE_URL;
  if (!statusUrl) throw new Error('Local Supabase status did not report an API URL.');
  assertMatchingTarget(statusUrl, localTargets.localSupabaseUrl, 'Supabase status API_URL');
}

async function checkPlaywrightConfig() {
  const config = await readFile(join(root, 'playwright.config.ts'), 'utf8');
  const projectNames = [...config.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  if (!projectNames.includes('chromium')) throw new Error('playwright.config.ts does not define the required chromium project.');
  if (!config.includes("devices['Desktop Chrome']")) throw new Error('playwright.config.ts no longer selects the verified Desktop Chrome device for chromium.');
  if (!config.includes('reuseExistingServer: true')) throw new Error('playwright.config.ts must retain its verified reusable server lifecycle.');
  if (!config.includes('supabase/functions/.env.test')) throw new Error('playwright.config.ts must serve local functions with supabase/functions/.env.test.');
  for (const url of config.match(/https?:\/\/[^'"\s]+/g) ?? []) assertLocalUrl(url, 'playwright.config.ts URL');
  const { chromium } = await import('@playwright/test');
  try {
    await access(chromium.executablePath());
  } catch {
    throw new Error('The configured bundled Chromium browser is not installed. Run `pnpm exec playwright install chromium`.');
  }
}

export async function preflight() {
  console.log('[verify:local] preflight: checking versions and dependencies.');
  await checkVersions();
  await checkDependencies();
  console.log('[verify:local] preflight: validating ignored local environment files and all effective URL targets.');
  const localTargets = await readLocalTargets();
  console.log('[verify:local] preflight: checking local Supabase availability and the configured chromium project.');
  await checkSupabase(localTargets);
  await checkPlaywrightConfig();
  console.log('[verify:local] preflight passed; no setup, reset, reseed, or generated-file action was performed.');
}

function elapsed(started) {
  return `${((performance.now() - started) / 1000).toFixed(1)}s`;
}

function runCommand(command, args) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolveProcess(code ?? 1));
  });
}

export async function runStages(stages = LOCAL_VERIFY_STAGES, execute = runCommand) {
  for (const stage of stages) {
    const started = performance.now();
    console.log(`[verify:local] START ${stage.name}`);
    let exitCode;
    try {
      exitCode = await execute(stage.command, stage.args);
    } catch (error) {
      throw new Error(`${stage.name} failed after ${elapsed(started)}; later stages were not run.`, { cause: error });
    }
    if (exitCode !== 0) throw new Error(`${stage.name} failed with exit code ${exitCode} after ${elapsed(started)}; later stages were not run.`);
    console.log(`[verify:local] PASS ${stage.name} (${elapsed(started)})`);
  }
}

async function main() {
  await preflight();
  await runStages();
  console.log('[verify:local] all stages passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(`[verify:local] ${error.message}`);
    process.exitCode = 1;
  });
}
