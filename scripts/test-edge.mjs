import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = join(root, 'supabase/functions');
const importMap = 'supabase/functions/deno.json';
const fallbackDenoVersion = '2.9.6';

export async function discoverEdgeTestFiles(directory = functionsRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await discoverEdgeTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(relative(root, path).split('/').join('/'));
    }
  }
  return files.sort();
}

export function edgeTestArguments(files) {
  if (!files.length) throw new Error('No applicable Edge test files were found under supabase/functions/.');
  return [
    'test',
    '--no-lock',
    '--node-modules-dir=none',
    '--allow-env=QNOTES_TOKEN_PEPPER,QNOTES_VAULT_TOKEN_PEPPER,QNOTES_VAULT_MUTATION_PEPPER_PREVIOUS,QNOTES_CLIENT_IP_HEADER,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY',
    `--import-map=${importMap}`,
    ...files,
  ];
}

export function denoInvocation(hasNativeDeno, args) {
  return hasNativeDeno
    ? { command: 'deno', args }
    : { command: 'pnpm', args: ['dlx', '--yes', `deno@${fallbackDenoVersion}`, ...args] };
}

function commandAvailable(command) {
  return new Promise((resolveAvailable) => {
    const child = spawn(command, ['--version'], { cwd: root, stdio: 'ignore' });
    child.once('error', () => resolveAvailable(false));
    child.once('close', (code) => resolveAvailable(code === 0));
  });
}

function runCommand(command, args) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveProcess({ code: code ?? 1, signal, output }));
  });
}

export async function runEdgeTests() {
  const files = await discoverEdgeTestFiles();
  const args = edgeTestArguments(files);
  const invocation = denoInvocation(await commandAvailable('deno'), args);
  process.env.DENO_NO_PACKAGE_JSON = '1';
  console.log(`[test:edge] discovered ${files.length} test files:`);
  for (const file of files) console.log(`[test:edge]   ${file}`);
  console.log(`[test:edge] running ${invocation.command === 'deno' ? 'native Deno' : `pnpm dlx deno@${fallbackDenoVersion}`} with package.json auto-resolution disabled, node_modules disabled, the checked-in import map, and lockfile writes disabled.`);

  const result = await runCommand(invocation.command, invocation.args);
  if (result.code !== 0) {
    throw new Error(`Deno Edge tests failed${result.signal ? ` (${result.signal})` : ` with exit code ${result.code}`}.`);
  }

  const summary = result.output.match(/ok \| (\d+) passed \| (\d+) failed/);
  if (summary) {
    console.log(`[test:edge] completed ${summary[1]} tests across ${files.length} files (${summary[2]} failed).`);
  } else {
    console.log(`[test:edge] completed successfully across ${files.length} files; Deno did not emit its usual summary.`);
  }
  return { files, tests: summary ? Number(summary[1]) : null };
}

async function main() {
  try {
    await runEdgeTests();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Deno is required on PATH for Edge tests. Install Deno 2.9.6 or newer, then rerun pnpm run test:edge.');
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(`[test:edge] ${error.message}`);
    process.exitCode = 1;
  });
}
