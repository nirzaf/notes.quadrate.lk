import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesMcpConfig } from '../dist/hermes.js';

const READ_TOOLS = ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share'];
const SHARE_TOOLS = ['create_public_share'];
const WRITE_TOOLS = ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook'];
const serverPath = '/opt/qnotes/packages/mcp-server/dist/index.js';
const deviceId = '11111111-1111-4111-8111-111111111111';

function generatedConfig(profile) {
  return JSON.parse(buildHermesMcpConfig({
    profile,
    serverPath,
    ...(profile === 'write' ? { deviceId } : {}),
  })).mcp_servers[`qnotes_${profile}`];
}

function generatedConfigWithVault(profile, vaultProfile) {
  return JSON.parse(buildHermesMcpConfig({
    profile,
    serverPath,
    vaultProfile,
    ...(profile === 'write' ? { deviceId } : {}),
  })).mcp_servers[`qnotes_${profile}`];
}

test('read, share, and write profiles use the hardened Hermes runtime policy', () => {
  const profiles = [
    { name: 'read', parallel: true, tools: READ_TOOLS, env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_READ_TOKEN}' } },
    { name: 'share', parallel: false, tools: [...READ_TOOLS, ...SHARE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_TOKEN}', QNOTES_MCP_PROFILE: 'share' } },
    { name: 'write', parallel: false, tools: [...READ_TOOLS, ...WRITE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_MCP_PROFILE: 'write', QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}', QNOTES_MCP_DEVICE_ID: deviceId } },
  ];

  for (const profile of profiles) {
    const config = generatedConfig(profile.name);
    assert.equal(config.command, 'node');
    assert.deepEqual(config.args, [serverPath]);
    assert.equal(config.connect_timeout, 10);
    assert.equal(config.timeout, 45);
    assert.equal(config.supports_parallel_tool_calls, profile.parallel);
    assert.deepEqual(config.tools.include, profile.tools);
    assert.deepEqual(config.env, profile.env);
    assert.doesNotMatch(JSON.stringify(config), /qnt_[A-Za-z0-9]+/);
  }
});

test('write profile requires a stable UUID device ID', () => {
  assert.throws(() => buildHermesMcpConfig({ profile: 'write', serverPath }), /stable UUID/);
  assert.throws(() => buildHermesMcpConfig({ profile: 'write', serverPath, deviceId: 'not-a-uuid' }), /stable UUID/);
  assert.equal(generatedConfig('write').env.QNOTES_MCP_DEVICE_ID, deviceId);
});

test('write profile omits public sharing by default and includes it only with explicit opt-in', () => {
  const defaultConfig = generatedConfig('write');
  assert.equal(defaultConfig.tools.include.includes('create_public_share'), false);
  assert.equal('QNOTES_MCP_ENABLE_PUBLIC_SHARE' in defaultConfig.env, false);

  const optInConfig = JSON.parse(buildHermesMcpConfig({ profile: 'write', serverPath, deviceId, includePublicShare: true })).mcp_servers.qnotes_write;
  assert.equal(optInConfig.env.QNOTES_MCP_ENABLE_PUBLIC_SHARE, 'true');
  assert.deepEqual(optInConfig.tools.include, [...READ_TOOLS, ...SHARE_TOOLS, ...WRITE_TOOLS]);
});

test('share profile selects only the share runtime without write or Vault settings', () => {
  const shareConfig = generatedConfig('share');
  assert.deepEqual(shareConfig.env, {
    QNOTES_URL: '${QNOTES_URL}',
    QNOTES_TOKEN: '${QNOTES_TOKEN}',
    QNOTES_MCP_PROFILE: 'share',
  });
  assert.deepEqual(shareConfig.tools.include, [...READ_TOOLS, ...SHARE_TOOLS]);
  assert.equal('QNOTES_WRITE_TOKEN' in shareConfig.env, false);
  assert.equal('QNOTES_MCP_DEVICE_ID' in shareConfig.env, false);
  assert.equal('QVAULT_TOKEN' in shareConfig.env, false);
  assert.equal('QVAULT_MCP_PROFILE' in shareConfig.env, false);

  const readConfig = generatedConfig('read');
  const writeConfig = generatedConfig('write');
  assert.equal('QNOTES_MCP_PROFILE' in readConfig.env, false);
  assert.equal(writeConfig.env.QNOTES_MCP_PROFILE, 'write');
});

test('combines every Vault profile with every Notes profile without exposing raw secrets', () => {
  const vaultProfiles = {
    none: { parallelWithRead: true, tools: [], env: {} },
    metadata: {
      parallelWithRead: true,
      tools: ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets'],
      env: { QVAULT_TOKEN: '${QVAULT_TOKEN}', QVAULT_MCP_PROFILE: 'metadata' },
    },
    reveal: {
      parallelWithRead: false,
      tools: ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets', 'vault_get_secret', 'vault_get_secrets'],
      env: { QVAULT_TOKEN: '${QVAULT_TOKEN}', QVAULT_MCP_PROFILE: 'reveal' },
    },
    write: {
      parallelWithRead: false,
      tools: ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets', 'vault_get_secret', 'vault_get_secrets', 'vault_create_secret', 'vault_rotate_secret', 'vault_delete_secret'],
      env: { QVAULT_TOKEN: '${QVAULT_TOKEN}', QVAULT_MCP_PROFILE: 'write' },
    },
  };
  const notesProfiles = {
    read: { parallel: true, tools: READ_TOOLS, env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_READ_TOKEN}' } },
    share: { parallel: false, tools: [...READ_TOOLS, ...SHARE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_TOKEN}', QNOTES_MCP_PROFILE: 'share' } },
    write: { parallel: false, tools: [...READ_TOOLS, ...WRITE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_MCP_PROFILE: 'write', QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}', QNOTES_MCP_DEVICE_ID: deviceId } },
  };

  for (const [notesProfile, notes] of Object.entries(notesProfiles)) {
    for (const [vaultProfile, vault] of Object.entries(vaultProfiles)) {
      const config = generatedConfigWithVault(notesProfile, vaultProfile);
      assert.deepEqual(config.tools.include, [...notes.tools, ...vault.tools]);
      assert.equal(config.supports_parallel_tool_calls, notesProfile === 'read' && vault.parallelWithRead);
      assert.deepEqual(config.env, { ...notes.env, ...vault.env });
      assert.equal('QVAULT_URL' in config.env, false);
      assert.doesNotMatch(JSON.stringify(config), /qvt_[A-Za-z0-9_-]+/);
    }
  }
});
