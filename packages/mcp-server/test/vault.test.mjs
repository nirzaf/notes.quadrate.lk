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
    async resolveEnvironment() { return { projectId: 'project-1', environmentId: 'environment-1', secretId: null }; },
    async resolveSecret() { return { projectId: 'project-1', environmentId: 'environment-1', secretId: 'secret-1' }; },
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
  assert.equal((await write.client.listTools()).tools.some((tool) => tool.name === 'vault_get_secret'), false);
  await write.client.close();
});

test('Vault MCP reveal requires purpose and returns the fake value only for exact retrieval', async () => {
  let received;
  const { client } = await connected('reveal', protocolClient({
    async revealSecret(input) { received = input; return { secretId: 'secret-1', project: 'p', environment: 'e', name: 'KEY', value: 'local-only-secret', version: 1, updatedAt: '2026-01-01' }; },
  }));
  const result = await client.callTool({ name: 'vault_get_secret', arguments: { project: 'p', environment: 'e', name: 'KEY', purpose: 'local test', confirmPlaintext: true } });
  assert.deepEqual(received, { project: 'p', environment: 'e', name: 'KEY', purpose: 'local test' });
  assert.equal(result.structuredContent.value, 'local-only-secret');
  const missingPurpose = await client.callTool({ name: 'vault_get_secret', arguments: { project: 'p', environment: 'e', name: 'KEY', confirmPlaintext: true } });
  assert.equal(missingPurpose.isError, true);
  const missingConfirmation = await client.callTool({ name: 'vault_get_secret', arguments: { project: 'p', environment: 'e', name: 'KEY', purpose: 'local test' } });
  assert.equal(missingConfirmation.isError, true);
  await client.close();
});

test('Vault list tools return object-shaped zero and many item pages', async () => {
  const project = { id: 'project-1', slug: 'local', name: 'Local', description: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null };
  const environment = { id: 'environment-1', projectId: 'project-1', slug: 'test', name: 'Test', description: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null };
  const secret = { id: 'secret-1', projectId: 'project-1', environmentId: 'environment-1', name: 'KEY', description: null, version: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', rotatedAt: null, deletedAt: null };
  const empty = await connected('metadata', protocolClient({
    async listProjects() { return []; },
  }));
  const emptyProjects = await empty.client.callTool({ name: 'vault_list_projects', arguments: {} });
  assert.deepEqual(emptyProjects.structuredContent, { items: [] });
  assert.deepEqual(JSON.parse(emptyProjects.content[0].text), emptyProjects.structuredContent);
  await empty.client.close();

  const secondProject = { ...project, id: 'project-2', slug: 'shared', name: 'Shared' };
  const secondEnvironment = { ...environment, id: 'environment-2', projectId: 'project-2', slug: 'stage', name: 'Stage' };
  const secondSecret = { ...secret, id: 'secret-2', projectId: 'project-2', environmentId: 'environment-2', name: 'TOKEN' };
  const { client } = await connected('metadata', protocolClient({
    async listProjects() { return [project, secondProject]; },
    async listEnvironments() { return [environment, secondEnvironment]; },
    async listSecrets() { return [secret, secondSecret]; },
  }));
  const projects = await client.callTool({ name: 'vault_list_projects', arguments: {} });
  const environments = await client.callTool({ name: 'vault_list_environments', arguments: { project: 'local' } });
  const secrets = await client.callTool({ name: 'vault_list_secrets', arguments: { project: 'local', environment: 'test' } });
  for (const result of [projects, environments, secrets]) {
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(Array.isArray(result.structuredContent.items), true);
    assert.equal(result.structuredContent.items.length, 2);
  }
  await client.close();
});

test('Vault MCP mutations resolve exact resources without enumerating parent collections', async () => {
  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const environmentId = '660e8400-e29b-41d4-a716-446655440000';
  const secretId = '770e8400-e29b-41d4-a716-446655440000';
  const metadata = { id: secretId, projectId, environmentId, name: 'KEY', description: null, version: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02', rotatedAt: '2026-01-02', deletedAt: null };
  const calls = [];
  let listEnvironmentCalls = 0;
  let listSecretCalls = 0;
  const { client } = await connected('write', protocolClient({
    async listEnvironments() { listEnvironmentCalls += 1; throw new Error('parent enumeration must not be used'); },
    async listSecrets() { listSecretCalls += 1; throw new Error('sibling enumeration must not be used'); },
    async resolveEnvironment(project, environment, action) {
      calls.push({ operation: 'resolveEnvironment', project, environment, action });
      return { projectId, environmentId, secretId: null };
    },
    async resolveSecret(input, action) {
      calls.push({ operation: 'resolveSecret', input, action });
      return { projectId, environmentId, secretId };
    },
    async createSecret(input) { calls.push({ operation: 'createSecret', input }); return metadata; },
    async rotateSecret(receivedSecretId, input) { calls.push({ operation: 'rotateSecret', receivedSecretId, input }); return metadata; },
    async deleteSecret(receivedSecretId, input) { calls.push({ operation: 'deleteSecret', receivedSecretId, input }); return { ...metadata, deletedAt: '2026-01-03' }; },
  }));

  await client.callTool({ name: 'vault_create_secret', arguments: { project: 'pearl-blanc', environment: 'production', name: 'KEY', value: 'synthetic', mutationId: '880e8400-e29b-41d4-a716-446655440000' } });
  await client.callTool({ name: 'vault_rotate_secret', arguments: { project: 'pearl-blanc', environment: 'production', name: 'KEY', value: 'synthetic-rotated', expectedVersion: 1, mutationId: '990e8400-e29b-41d4-a716-446655440000' } });
  await client.callTool({ name: 'vault_delete_secret', arguments: { project: 'pearl-blanc', environment: 'production', name: 'KEY', expectedVersion: 2, mutationId: 'aa0e8400-e29b-41d4-a716-446655440000', confirm: true } });

  assert.equal(listEnvironmentCalls, 0);
  assert.equal(listSecretCalls, 0);
  assert.deepEqual(calls.map((call) => call.operation), ['resolveEnvironment', 'createSecret', 'resolveSecret', 'rotateSecret', 'resolveSecret', 'deleteSecret']);
  assert.deepEqual(calls[3], { operation: 'rotateSecret', receivedSecretId: secretId, input: { value: 'synthetic-rotated', expectedVersion: 1, mutationId: '990e8400-e29b-41d4-a716-446655440000' } });
  assert.deepEqual(calls[5], { operation: 'deleteSecret', receivedSecretId: secretId, input: { expectedVersion: 2, mutationId: 'aa0e8400-e29b-41d4-a716-446655440000', confirm: true } });
  await client.close();
});
