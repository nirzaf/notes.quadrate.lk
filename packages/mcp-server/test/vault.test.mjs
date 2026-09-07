import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createQNotesMcpServer, VAULT_METADATA_TOOL_NAMES, VAULT_REVEAL_TOOL_NAMES, VAULT_WRITE_TOOL_NAMES } from '../dist/server.js';

function protocolClient(overrides = {}) {
  return {
    async searchPost() { return { items: [], queryId: 'q', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 0, totalMs: 0 } }; },
    async readNoteContext() { throw new Error('not used'); },
    async getBlock() { throw new Error('not used'); },
    async listNotebooks() { return { items: [] }; },
    async resolvePublicShare() { throw new Error('not used'); },
    async listProjects() { return { items: [] }; },
    async listEnvironments() { return { items: [] }; },
    async listSecrets() { return []; },
    ...overrides,
  };
}

async function connected(profile, apiClient, vaultClient = apiClient) {
  const server = createQNotesMcpServer(apiClient, 'read', { vaultClient, vaultProfile: profile });
  const client = new Client({ name: 'vault-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('Vault MCP profiles expose metadata, reveal, and write tools independently', async () => {
  const metadata = await connected('metadata', protocolClient());
  assert.deepEqual((await metadata.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith('vault_')), [...VAULT_METADATA_TOOL_NAMES]);
  await metadata.client.close();
  const reveal = await connected('reveal', protocolClient());
  assert.deepEqual((await reveal.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith('vault_')), [...VAULT_REVEAL_TOOL_NAMES]);
  await reveal.client.close();
  const write = await connected('write', protocolClient());
  assert.deepEqual((await write.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith('vault_')), [...VAULT_WRITE_TOOL_NAMES]);
  await write.client.close();
});

test('Vault MCP reveal requires purpose and returns the fake value only for exact retrieval', async () => {
  let received;
  const { client } = await connected('reveal', protocolClient({
    async revealSecret(input) { received = input; return { secretId: 'secret-1', project: 'p', environment: 'e', name: 'KEY', value: 'local-only-secret', version: 1, updatedAt: '2026-01-01' }; },
  }));
  const result = await client.callTool({ name: 'vault_get_secret', arguments: { project: 'p', environment: 'e', name: 'KEY', purpose: 'local test' } });
  assert.deepEqual(received, { project: 'p', environment: 'e', name: 'KEY', purpose: 'local test' });
  assert.equal(result.structuredContent.value, 'local-only-secret');
  const missingPurpose = await client.callTool({ name: 'vault_get_secret', arguments: { project: 'p', environment: 'e', name: 'KEY' } });
  assert.equal(missingPurpose.isError, true);
  await client.close();
});
