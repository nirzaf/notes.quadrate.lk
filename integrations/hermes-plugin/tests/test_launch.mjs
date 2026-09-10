import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { validateApiEndpoint } from '../endpoint-policy.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDirectory, '../../..');
const launcher = join(repoRoot, 'integrations', 'hermes-plugin', 'launch.mjs');

test('standalone endpoint policy rejects empty delimiters and encoded dot segments', () => {
  for (const value of ['https://example.test?', 'https://example.test#', 'https://example.test/functions/%2e%2e/qnotes-api', 'https://example.test/functions/%2f../qnotes-api']) {
    assert.throws(() => validateApiEndpoint(value), /API endpoint/);
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qnotes-hermes-launch-'));
  const runtimeDirectory = join(root, 'runtime with spaces');
  const serverPath = join(runtimeDirectory, 'fake server.mjs');
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(serverPath, `
    const names = [
      'QNOTES_URL', 'QNOTES_MCP_PROFILE', 'QNOTES_TOKEN',
      'QNOTES_READ_TOKEN', 'QNOTES_WRITE_TOKEN', 'QNOTES_MCP_DEVICE_ID',
      'QNOTES_MCP_ENABLE_PUBLIC_SHARE', 'QVAULT_TOKEN', 'QVAULT_MCP_PROFILE',
      'QNOTES_ALLOW_INSECURE_LOOPBACK', 'QVAULT_URL', 'QNOTES_PLUGIN_TOKEN', 'QNOTES_PLUGIN_VAULT_TOKEN'
    ];
    process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));
  `);
  return { root, serverPath };
}

function runLauncher(serverPath, options = {}, environment = {}) {
  const args = [launcher, '--server-path', serverPath, '--notes-profile', options.notesProfile ?? 'read', '--vault-profile', options.vaultProfile ?? 'none'];
  if (options.includePublicShare) args.push('--include-public-share');
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

test('launcher isolates read/none from conflicting inherited credentials', async (t) => {
  const { root, serverPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: 'qnt_selected_read',
    QNOTES_TOKEN: 'qnt_parent_share',
    QNOTES_READ_TOKEN: 'qnt_parent_read',
    QNOTES_WRITE_TOKEN: 'qnt_parent_write',
    QNOTES_MCP_PROFILE: 'write',
    QNOTES_MCP_ENABLE_PUBLIC_SHARE: 'true',
    QNOTES_MCP_DEVICE_ID: 'not-a-device-id',
    QVAULT_TOKEN: 'qvt_parent',
    QVAULT_MCP_PROFILE: 'write',
  });

  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_MCP_PROFILE: 'read',
    QNOTES_TOKEN: null,
    QNOTES_READ_TOKEN: 'qnt_selected_read',
    QNOTES_WRITE_TOKEN: null,
    QNOTES_MCP_DEVICE_ID: null,
    QNOTES_MCP_ENABLE_PUBLIC_SHARE: null,
    QNOTES_ALLOW_INSECURE_LOOPBACK: null,
    QVAULT_TOKEN: null,
    QVAULT_MCP_PROFILE: null,
    QVAULT_URL: null,
    QNOTES_PLUGIN_TOKEN: null,
    QNOTES_PLUGIN_VAULT_TOKEN: null,
  });
});

test('launcher selects write/public-share and Vault reveal credentials explicitly', async (t) => {
  const { root, serverPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runLauncher(serverPath, { notesProfile: 'write', vaultProfile: 'reveal', includePublicShare: true }, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: 'qnt_selected_write',
    QNOTES_PLUGIN_VAULT_TOKEN: 'qvt_selected_reveal',
    QNOTES_MCP_DEVICE_ID: '11111111-1111-4111-8111-111111111111',
    QNOTES_ALLOW_INSECURE_LOOPBACK: 'true',
    QNOTES_TOKEN: 'qnt_parent_share',
    QNOTES_READ_TOKEN: 'qnt_parent_read',
    QNOTES_WRITE_TOKEN: 'qnt_parent_write',
    QVAULT_TOKEN: 'qvt_parent',
    QVAULT_MCP_PROFILE: 'metadata',
  });

  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.QNOTES_MCP_PROFILE, 'write');
  assert.equal(observed.QNOTES_WRITE_TOKEN, 'qnt_selected_write');
  assert.equal(observed.QNOTES_READ_TOKEN, null);
  assert.equal(observed.QNOTES_TOKEN, null);
  assert.equal(observed.QNOTES_MCP_DEVICE_ID, '11111111-1111-4111-8111-111111111111');
  assert.equal(observed.QNOTES_MCP_ENABLE_PUBLIC_SHARE, 'true');
  assert.equal(observed.QNOTES_ALLOW_INSECURE_LOOPBACK, 'true');
  assert.equal(observed.QVAULT_TOKEN, 'qvt_selected_reveal');
  assert.equal(observed.QVAULT_MCP_PROFILE, 'reveal');
  assert.equal(observed.QVAULT_URL, null);
  assert.equal(observed.QNOTES_PLUGIN_TOKEN, null);
  assert.equal(observed.QNOTES_PLUGIN_VAULT_TOKEN, null);
});

test('launcher fails without selected token instead of falling back to ambient token', async (t) => {
  const { root, serverPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: '',
    QNOTES_TOKEN: 'qnt_unrelated_ambient',
  });

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /qnt_unrelated_ambient/);
  assert.doesNotMatch(result.stdout, /qnt_unrelated_ambient/);
});

test('launcher rejects unsupported alternate Vault URL and unresolved placeholders safely', async (t) => {
  const { root, serverPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const alternate = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: 'qnt_selected_read',
    QVAULT_URL: 'https://other.example.test/vault',
  });
  assert.notEqual(alternate.code, 0);
  assert.doesNotMatch(alternate.stderr, /other\.example/);

  const unresolved = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'https://notes.example.test/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: '${QNOTES_READ_TOKEN}',
  });
  assert.notEqual(unresolved.code, 0);
  assert.doesNotMatch(unresolved.stderr, /QNOTES_READ_TOKEN/);
});

test('launcher accepts only exact loopback HTTP for local tests', async (t) => {
  const { root, serverPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const local = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'http://127.0.0.1:54321/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: 'qnt_local',
    QNOTES_ALLOW_INSECURE_LOOPBACK: 'true',
  });
  assert.equal(local.code, 0, local.stderr);

  const implicit = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'http://127.0.0.1:54321/functions/v1/qnotes-api',
    QNOTES_PLUGIN_TOKEN: 'qnt_local',
  });
  assert.notEqual(implicit.code, 0);

  const lookalike = await runLauncher(serverPath, {}, {
    QNOTES_URL: 'http://127.0.0.1.attacker.test/api',
    QNOTES_PLUGIN_TOKEN: 'qnt_local',
  });
  assert.notEqual(lookalike.code, 0);
});
