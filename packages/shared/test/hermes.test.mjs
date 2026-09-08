import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesMcpConfig } from '../dist/hermes.js';

const READ_TOOLS = ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share'];
const SHARE_TOOLS = ['create_public_share'];
const WRITE_TOOLS = ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook'];
const serverPath = '/opt/quadrate-notes/packages/mcp-server/dist/index.js';
const deviceId = '11111111-1111-4111-8111-111111111111';

function generatedConfig(profile) {
  return JSON.parse(buildHermesMcpConfig({
    profile,
    serverPath,
    ...(profile === 'write' ? { deviceId } : {}),
  })).mcp_servers[`quadrate_notes_${profile}`];
}

test('read, share, and write profiles use the hardened Hermes runtime policy', () => {
  const profiles = [
    { name: 'read', parallel: true, tools: READ_TOOLS, env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_READ_TOKEN}' } },
    { name: 'share', parallel: false, tools: [...READ_TOOLS, ...SHARE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_TOKEN}' } },
    { name: 'write', parallel: false, tools: [...READ_TOOLS, ...SHARE_TOOLS, ...WRITE_TOOLS], env: { QNOTES_URL: '${QNOTES_URL}', QNOTES_MCP_PROFILE: 'write', QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}', QNOTES_MCP_DEVICE_ID: deviceId } },
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
