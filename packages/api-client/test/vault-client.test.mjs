import test from 'node:test';
import assert from 'node:assert/strict';
import { QVaultClient, QVaultProtocolError } from '../dist/index.js';

const project = { id: '550e8400-e29b-41d4-a716-446655440000', slug: 'pearl-blanc', name: 'Pearl Blanc', description: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null };
const secret = { id: '770e8400-e29b-41d4-a716-446655440000', projectId: project.id, environmentId: '660e8400-e29b-41d4-a716-446655440000', name: 'CLOUDFLARE_API_TOKEN', description: null, version: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02', rotatedAt: '2026-01-02', deletedAt: null };

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('QVaultClient sends qvt authorization only to isolated Vault routes', async () => {
  const calls = [];
  const client = new QVaultClient({ baseUrl: 'http://example.test///', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ items: [project] });
  } });
  await client.listProjects();
  assert.equal(calls[0].url, 'http://example.test/vault/projects');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer qvt_test');
  assert.equal(calls[0].url.includes('/api/'), false);
});

test('QVaultClient lists effective multiple grants and sends replacement payloads', async () => {
  const calls = [];
  const grants = [
    { id: 'grant-1', projectId: project.id, projectName: 'Pearl Blanc', environmentId: null, secretId: null, action: 'metadata:read', createdAt: '2026-01-01' },
    { id: 'grant-2', projectId: project.id, projectName: 'Pearl Blanc', environmentId: secret.environmentId, environmentName: 'production', secretId: secret.id, secretName: secret.name, action: 'secret:reveal', createdAt: '2026-01-02' },
  ];
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/agent-tokens')) return jsonResponse([{ id: 'token-1', name: 'Deploy agent', tokenPrefix: 'qvt_12345678', expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: '2026-01-01', grants }]);
    return jsonResponse(grants);
  } });

  const tokens = await client.listAgentTokens();
  assert.deepEqual(tokens[0].grants, grants);
  const replaced = await client.replaceAgentGrants('token-1', [grants[1]]);
  assert.deepEqual(replaced, [grants[0], grants[1]]);
  assert.equal(calls[1].url, 'http://example.test/vault/agent-tokens/token-1/grants');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].init.body), { grants: [grants[1]] });
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer jwt-test');
});

test('QVaultClient rejects grant responses that contain plaintext fields', async () => {
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async () => jsonResponse([{ projectId: project.id, environmentId: null, secretId: null, action: 'metadata:read', value: 'must-not-leak' }]) });
  await assert.rejects(() => client.replaceAgentGrants('token-1', []), (error) => {
    assert.ok(error instanceof QVaultProtocolError);
    assert.match(error.message, /malformed agent grants/);
    assert.equal(error.message.includes('must-not-leak'), false);
    return true;
  });
});

test('QVaultClient validates metadata and reveal responses without caching plaintext', async () => {
  const calls = [];
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/reveal')) return jsonResponse({ secretId: secret.id, project: project.slug, environment: 'production', name: secret.name, value: 'local-only-secret', version: secret.version, updatedAt: secret.updatedAt }, 200, { 'cache-control': 'no-store' });
    return jsonResponse([secret]);
  } });
  const listed = await client.listSecrets(secret.environmentId);
  assert.equal('value' in listed[0], false);
  const revealed = await client.revealSecret({ project: 'pearl-blanc', environment: 'production', name: secret.name, purpose: 'local test' });
  assert.equal(revealed.value, 'local-only-secret');
  assert.equal(calls[1].url, 'http://example.test/vault/secrets/reveal');
  assert.equal(JSON.parse(calls[1].init.body).name, secret.name);
  assert.equal(JSON.parse(calls[1].init.body).value, undefined);
});

test('QVaultClient preserves the explicit bounded batch reveal contract', async () => {
  const calls = [];
  const item = { secretId: secret.id, project: project.slug, environment: 'production', name: secret.name, value: 'local-only-batch-secret', version: secret.version, updatedAt: secret.updatedAt };
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ items: [item] }, 200, { 'cache-control': 'no-store' });
  } });
  const result = await client.revealSecrets({ secrets: [{ project: project.slug, environment: 'production', name: secret.name }], purpose: 'local batch test' });
  assert.deepEqual(result, { items: [item] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://example.test/vault/secrets/reveal-batch');
  assert.deepEqual(JSON.parse(calls[0].init.body), { secrets: [{ project: project.slug, environment: 'production', name: secret.name }], purpose: 'local batch test' });
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer qvt_test');
});

test('QVaultClient rejects malformed reveal payloads without echoing the response', async () => {
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async () => jsonResponse({ value: 'must-not-echo' }) });
  await assert.rejects(() => client.revealSecret({ project: 'p', environment: 'e', name: 'KEY', purpose: 'test' }), (error) => {
    assert.ok(error instanceof QVaultProtocolError);
    assert.match(error.message, /malformed reveal/);
    assert.equal(error.message.includes('must-not-echo'), false);
    return true;
  });
});

test('QVaultClient validates safe audit actor identity and rejects secret fields', async () => {
  const event = {
    id: '880e8400-e29b-41d4-a716-446655440000',
    actorKind: 'vault_agent',
    actorTokenId: '990e8400-e29b-41d4-a716-446655440000',
    actorTokenName: 'Deploy agent',
    actorTokenPrefix: 'qvt_12345678',
    action: 'secret:reveal',
    projectId: project.id,
    environmentId: secret.environmentId,
    secretId: secret.id,
    purpose: 'audit identity test',
    success: false,
    resultCode: 'access_denied',
    requestId: 'aa0e8400-e29b-41d4-a716-446655440000',
    occurredAt: '2026-01-03T00:00:00.000Z',
  };
  const userEvent = { ...event, id: 'aa0e8400-e29b-41d4-a716-446655440000', actorKind: 'user_jwt', actorTokenId: null, actorTokenName: null, actorTokenPrefix: null };
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async () => jsonResponse([event, userEvent]) });
  assert.deepEqual(await client.listAudit(), [event, userEvent]);

  const unsafeClient = new QVaultClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => 'jwt-test',
    fetchImplementation: async () => jsonResponse([{ ...event, token_hash: 'must-not-leak', value: 'must-not-leak' }]),
  });
  await assert.rejects(() => unsafeClient.listAudit(), (error) => {
    assert.ok(error instanceof QVaultProtocolError);
    assert.match(error.message, /malformed audit events/);
    assert.equal(error.message.includes('must-not-leak'), false);
    return true;
  });
});
