import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildHermesMcpConfig } from '../../../packages/shared/dist/hermes.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDirectory, '../../..');
const exporter = join(repoRoot, 'scripts', 'export-hermes-plugin-config.mjs');

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'qnotes-hermes-config-'));
  const pluginDir = join(root, 'plugin with spaces');
  const runtimeDirectory = join(root, 'runtime with spaces');
  const serverPath = join(runtimeDirectory, 'index.js');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(join(pluginDir, 'skills', 'workflow'), { recursive: true }),
  ]));
  await writeFile(join(pluginDir, 'plugin.yaml'), 'name: qnotes\n');
  await writeFile(serverPath, '');
  for (const file of ['__init__.py', 'commands.py', 'launch.mjs', 'README.md']) {
    await writeFile(join(pluginDir, file), '');
  }
  await writeFile(join(pluginDir, 'skills', 'workflow', 'SKILL.md'), '');
  return { root, pluginDir, serverPath };
}

function runExporter(args, env = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [exporter, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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

function argsFor(fixture, notesProfile, vaultProfile, extra = []) {
  return [
    '--server-path', fixture.serverPath,
    '--plugin-dir', fixture.pluginDir,
    '--notes-profile', notesProfile,
    '--vault-profile', vaultProfile,
    ...(notesProfile === 'write' ? ['--device-id', '11111111-1111-4111-8111-111111111111'] : []),
    ...extra,
  ];
}

test('exporter preserves canonical tool exposure and parallelism for all twelve combinations', async (t) => {
  const fixture = await fixtures();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const profiles = ['read', 'share', 'write'];
  const vaultProfiles = ['none', 'metadata', 'reveal', 'write'];

  for (const notesProfile of profiles) {
    for (const vaultProfile of vaultProfiles) {
      const result = await runExporter(argsFor(fixture, notesProfile, vaultProfile));
      assert.equal(result.code, 0, `${notesProfile}/${vaultProfile}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      const canonical = JSON.parse(buildHermesMcpConfig({
        profile: notesProfile,
        serverPath: fixture.serverPath,
        vaultProfile,
        ...(notesProfile === 'write' ? { deviceId: '11111111-1111-4111-8111-111111111111' } : {}),
      }));
      const name = `qnotes_${notesProfile}`;
      const actualServer = output.mcp_servers[name];
      const canonicalServer = canonical.mcp_servers[name];
      assert.deepEqual(actualServer.tools, canonicalServer.tools, `${notesProfile}/${vaultProfile} tools`);
      assert.equal(actualServer.supports_parallel_tool_calls, canonicalServer.supports_parallel_tool_calls);
      assert.equal(actualServer.connect_timeout, canonicalServer.connect_timeout);
      assert.equal(actualServer.timeout, canonicalServer.timeout);
      assert.equal(actualServer.prompts, false);
      assert.equal(actualServer.args[0], join(fixture.pluginDir, 'launch.mjs'));
      assert.equal(actualServer.args[1], '--server-path');
      assert.equal(actualServer.args[2], fixture.serverPath);
      assert.deepEqual(actualServer.args.slice(3), [
        '--notes-profile', notesProfile,
        '--vault-profile', vaultProfile,
      ]);
      assert.equal(actualServer.env.QNOTES_URL, '${QNOTES_URL}');
      assert.ok(actualServer.env.QNOTES_PLUGIN_TOKEN);
      assert.equal('QNOTES_TOKEN' in actualServer.env, false);
      assert.equal('QNOTES_READ_TOKEN' in actualServer.env, false);
      assert.equal('QNOTES_WRITE_TOKEN' in actualServer.env, false);
      assert.equal('QVAULT_TOKEN' in actualServer.env, false);
      assert.equal('QVAULT_URL' in actualServer.env, false);
      assert.equal(output.plugins.entries.qnotes.settings.server_name, name);
      assert.equal(output.plugins.entries.qnotes.settings.notes_profile, notesProfile);
      assert.equal(output.plugins.entries.qnotes.settings.vault_profile, vaultProfile);
      assert.equal('enabled' in output.plugins, false);
      assert.doesNotMatch(result.stdout, /qnt_[A-Za-z0-9_-]{8,}/);
      assert.doesNotMatch(result.stdout, /qvt_[A-Za-z0-9_-]{8,}/);
    }
  }
});

test('exporter retains explicit public share and status-grant choices only', async (t) => {
  const fixture = await fixtures();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runExporter(argsFor(fixture, 'write', 'none', ['--include-public-share', '--allow-status-probe']));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const server = output.mcp_servers.qnotes_write;
  assert.equal(server.env.QNOTES_PLUGIN_TOKEN, '${QNOTES_WRITE_TOKEN}');
  assert.equal(server.env.QNOTES_MCP_DEVICE_ID, '11111111-1111-4111-8111-111111111111');
  assert.equal(server.env.QNOTES_PLUGIN_VAULT_TOKEN, undefined);
  assert.ok(server.tools.include.includes('create_public_share'));
  assert.ok(server.args.includes('--include-public-share'));
  assert.deepEqual(output.plugins.entries.qnotes.mcp_allowlist, ['qnotes_write']);
  assert.match(result.stderr, /server-wide/);
  assert.doesNotMatch(result.stdout + result.stderr, /qnt_[A-Za-z0-9_-]{8,}|qvt_[A-Za-z0-9_-]{8,}/);
});

test('exporter rejects invalid profiles, paths, UUIDs, and incompatible share opt-in', async (t) => {
  const fixture = await fixtures();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const cases = [
    ['--notes-profile', 'bogus'],
    ['--vault-profile', 'bogus'],
    ['--plugin-dir', join(fixture.root, 'missing')],
    ['--server-path', join(fixture.root, 'missing.js')],
    ['--notes-profile', 'write', '--device-id', 'not-a-uuid'],
    ['--notes-profile', 'read', '--include-public-share'],
  ];
  for (const override of cases) {
    const base = argsFor(fixture, 'read', 'none');
    for (let index = 0; index < override.length; index += 2) {
      const flag = override[index];
      const value = override[index + 1];
      const position = base.indexOf(flag);
      if (position >= 0 && value !== undefined) base[position + 1] = value;
      else base.push(flag, value);
    }
    const result = await runExporter(base);
    assert.notEqual(result.code, 0, override.join(' '));
    assert.doesNotMatch(result.stderr, /qnt_|qvt_/);
  }
});

test('exporter never reads expanded credential values from its environment', async (t) => {
  const fixture = await fixtures();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sentinel = 'qnt_SENTINEL_MUST_NOT_BE_EMITTED';
  const result = await runExporter(argsFor(fixture, 'read', 'none'), {
    QNOTES_READ_TOKEN: sentinel,
    QNOTES_TOKEN: sentinel,
    QNOTES_WRITE_TOKEN: sentinel,
    QVAULT_TOKEN: 'qvt_SENTINEL_MUST_NOT_BE_EMITTED',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /SENTINEL_MUST_NOT_BE_EMITTED/);
});
