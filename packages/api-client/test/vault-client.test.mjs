import test from 'node:test';
import assert from 'node:assert/strict';
import { QVaultClient, QVaultProtocolError } from '../dist/index.js';

const project = { id: '550e8400-e29b-41d4-a716-446655440000', slug: 'pearl-blanc', name: 'Pearl Blanc', description: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null };
const environment = { id: '660e8400-e29b-41d4-a716-446655440000', projectId: project.id, slug: 'production', name: 'Production', description: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null };
const secret = { id: '770e8400-e29b-41d4-a716-446655440000', projectId: project.id, environmentId: '660e8400-e29b-41d4-a716-446655440000', name: 'CLOUDFLARE_API_TOKEN', description: null, version: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02', rotatedAt: '2026-01-02', deletedAt: null };
const tokenMetadata = { id: '990e8400-e29b-41d4-a716-446655440000', name: 'Deploy agent', tokenPrefix: 'qvt_12345678', expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: '2026-01-01', grants: [] };

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('QVaultClient sends qvt authorization only to isolated Vault routes', async () => {
  const calls = [];
  const client = new QVaultClient({ baseUrl: 'https://example.test///', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ items: [project] });
  } });
  await client.listProjects();
  assert.equal(calls[0].url, 'https://example.test/vault/projects');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer qvt_test');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].url.includes('/api/'), false);
});

test('QVaultClient keeps single-use Vault approvals in headers and validates the response', async () => {
  const calls = [];
  const client = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => 'jwt-test',
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ approvalToken: `qva_${'A'.repeat(43)}`, expiresAt: '2026-01-01T00:01:00.000Z' });
    },
  });
  const approval = await client.issueApproval({ action: 'secret:reveal', projectId: project.id, environmentId: secret.environmentId, secretId: secret.id, expectedVersion: null, requestHash: 'a'.repeat(64) });
  assert.equal(approval.approvalToken, `qva_${'A'.repeat(43)}`);
  assert.equal(calls[0].url, 'https://example.test/vault/approvals');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer jwt-test');
  assert.equal(calls[0].init.headers.get('X-Vault-Approval'), null);

  const revealClient = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => 'jwt-test',
    fetchImplementation: async (url, init) => {
      assert.equal(url, 'https://example.test/vault/secrets/reveal');
      assert.equal(init.headers.get('X-Vault-Approval'), approval.approvalToken);
      assert.equal(init.headers.get('X-Vault-Request-Hash'), 'a'.repeat(64));
      return jsonResponse({ secretId: secret.id, project: project.slug, environment: environment.slug, name: secret.name, value: 'synthetic-approved-secret', version: secret.version, updatedAt: secret.updatedAt });
    },
  });
  await revealClient.revealSecret({ project: project.slug, environment: environment.slug, name: secret.name, purpose: 'approval header test' }, { vaultApproval: { approvalToken: approval.approvalToken, requestHash: 'a'.repeat(64) } });
});

test('QVaultClient requires HTTPS or explicitly enabled exact loopback HTTP endpoints', async () => {
  assert.throws(() => new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => null }), /API endpoint/);
  assert.doesNotThrow(() => new QVaultClient({ baseUrl: 'http://localhost:54321', allowInsecureLoopback: true, getAccessToken: () => null }));
});

test('QVaultClient sanitizes access-token and transport failures', async () => {
  const secret = 'qvt_synthetic_transport_secret';
  const tokenFailure = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => { throw new Error(`provider leaked ${secret}`); },
    fetchImplementation: async () => jsonResponse([]),
  });
  await assert.rejects(() => tokenFailure.listProjects(), (error) => error.message === 'QVault request failed.' && !error.message.includes(secret));

  const fetchFailure = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => secret,
    fetchImplementation: async () => { throw new Error(`network leaked ${secret}`); },
  });
  await assert.rejects(() => fetchFailure.listProjects(), (error) => error.message === 'QVault request failed.' && !error.message.includes(secret));
});

test('QVaultClient aborts hung requests at the configured deadline', async () => {
  let requestSignal;
  const client = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      requestSignal = init.signal;
      return waitForAbort(init.signal);
    },
  });
  await assert.rejects(client.listProjects({ timeoutMs: 10 }), (error) => error?.name === 'TimeoutError');
  assert.equal(requestSignal.aborted, true);
});

test('QVaultClient lists effective multiple grants and sends replacement payloads', async () => {
  const calls = [];
  const grants = [
    { id: 'grant-1', projectId: project.id, projectName: 'Pearl Blanc', environmentId: null, secretId: null, action: 'metadata:read', createdAt: '2026-01-01' },
    { id: 'grant-2', projectId: project.id, projectName: 'Pearl Blanc', environmentId: secret.environmentId, environmentName: 'production', secretId: secret.id, secretName: secret.name, action: 'secret:reveal', createdAt: '2026-01-02' },
  ];
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/agent-tokens')) return jsonResponse([{ id: 'token-1', name: 'Deploy agent', tokenPrefix: 'qvt_12345678', expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: '2026-01-01', grants }]);
    return jsonResponse(grants);
  } });

  const tokens = await client.listAgentTokens();
  assert.deepEqual(tokens[0].grants, grants);
  const replaced = await client.replaceAgentGrants('token-1', [grants[1]]);
  assert.deepEqual(replaced, [grants[0], grants[1]]);
  assert.equal(calls[1].url, 'https://example.test/vault/agent-tokens/token-1/grants');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].init.body), { grants: [grants[1]] });
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer jwt-test');
});

test('QVaultClient rejects grant responses that contain plaintext fields', async () => {
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async () => jsonResponse([{ projectId: project.id, environmentId: null, secretId: null, action: 'metadata:read', value: 'must-not-leak' }]) });
  await assert.rejects(() => client.replaceAgentGrants('token-1', []), (error) => {
    assert.ok(error instanceof QVaultProtocolError);
    assert.match(error.message, /malformed agent grants/);
    assert.equal(error.message.includes('must-not-leak'), false);
    return true;
  });
});

test('QVaultClient validates metadata and reveal responses without caching plaintext', async () => {
  const calls = [];
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/reveal')) return jsonResponse({ secretId: secret.id, project: project.slug, environment: 'production', name: secret.name, value: 'local-only-secret', version: secret.version, updatedAt: secret.updatedAt }, 200, { 'cache-control': 'no-store' });
    return jsonResponse([secret]);
  } });
  const listed = await client.listSecrets(secret.environmentId);
  assert.equal('value' in listed[0], false);
  const revealed = await client.revealSecret({ project: 'pearl-blanc', environment: 'production', name: secret.name, purpose: 'local test' });
  assert.equal(revealed.value, 'local-only-secret');
  assert.equal(calls[1].url, 'https://example.test/vault/secrets/reveal');
  assert.equal(JSON.parse(calls[1].init.body).name, secret.name);
  assert.equal(JSON.parse(calls[1].init.body).value, undefined);
});

test('QVaultClient accepts the current agent token creation response shape', async () => {
  const token = `qvt_${'A'.repeat(43)}`;
  const client = new QVaultClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => 'jwt-test',
    fetchImplementation: async () => jsonResponse({ token, metadata: tokenMetadata, grants: [] }),
  });
  assert.deepEqual(await client.createAgentToken({ name: tokenMetadata.name, expiresAt: null, grants: [{ projectId: project.id, environmentId: null, secretId: null, action: 'metadata:read' }] }), {
    token,
    metadata: tokenMetadata,
    grants: [],
  });
});

test('QVaultClient rejects unexpected and secret-bearing fields across Vault payloads', async () => {
  const grant = { projectId: project.id, environmentId: null, secretId: null, action: 'metadata:read' };
  const revealItem = { secretId: secret.id, project: project.slug, environment: environment.slug, name: secret.name, value: 'synthetic-reveal-value', version: secret.version, updatedAt: secret.updatedAt };
  const auditEvent = {
    id: '880e8400-e29b-41d4-a716-446655440000',
    actorKind: 'user_jwt',
    actorTokenId: null,
    actorTokenName: null,
    actorTokenPrefix: null,
    action: 'metadata:read',
    projectId: project.id,
    environmentId: environment.id,
    secretId: secret.id,
    purpose: 'synthetic audit purpose',
    success: true,
    resultCode: null,
    requestId: 'aa0e8400-e29b-41d4-a716-446655440000',
    occurredAt: '2026-01-03T00:00:00.000Z',
  };
  const token = `qvt_${'B'.repeat(43)}`;
  const cases = [
    { resource: 'projects', response: { items: [{ ...project, ciphertext: 'synthetic-ciphertext' }] }, request: (client) => client.listProjects(), leaked: 'synthetic-ciphertext' },
    { resource: 'project', response: { ...project, tokenHash: 'synthetic-token-hash' }, request: (client) => client.createProject({ name: project.name }), leaked: 'synthetic-token-hash' },
    { resource: 'environments', response: [{ ...environment, token: 'synthetic-token' }], request: (client) => client.listEnvironments(project.id), leaked: 'synthetic-token' },
    { resource: 'environment', response: { ...environment, value: 'synthetic-value' }, request: (client) => client.createEnvironment(project.id, { name: environment.name }), leaked: 'synthetic-value' },
    { resource: 'secret metadata', response: { ...secret, ciphertext: 'synthetic-ciphertext' }, request: (client) => client.getSecret(secret.id), leaked: 'synthetic-ciphertext' },
    { resource: 'agent tokens', response: { items: [{ ...tokenMetadata, tokenHash: 'synthetic-token-hash' }] }, request: (client) => client.listAgentTokens(), leaked: 'synthetic-token-hash' },
    { resource: 'agent grants', response: { items: [grant], token_hash: 'synthetic-token-hash' }, request: (client) => client.replaceAgentGrants(tokenMetadata.id, []), leaked: 'synthetic-token-hash' },
    { resource: 'audit events', response: [{ ...auditEvent, token_hash: 'synthetic-token-hash' }], request: (client) => client.listAudit(), leaked: 'synthetic-token-hash' },
    { resource: 'reveal batch', response: { items: [revealItem], extra: 'synthetic-extra' }, request: (client) => client.revealSecrets({ secrets: [{ project: project.slug, environment: environment.slug, name: secret.name }], purpose: 'synthetic batch' }), leaked: 'synthetic-extra' },
    { resource: 'agent token', response: { token, metadata: tokenMetadata, grants: [], tokenHash: 'synthetic-token-hash' }, request: (client) => client.createAgentToken({ name: tokenMetadata.name, expiresAt: null, grants: [grant] }), leaked: 'synthetic-token-hash' },
  ];

  for (const testCase of cases) {
    const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async () => jsonResponse(testCase.response) });
    await assert.rejects(() => testCase.request(client), (error) => {
      assert.ok(error instanceof QVaultProtocolError);
      assert.match(error.message, new RegExp(`malformed ${testCase.resource}`));
      assert.equal(error.message.includes(testCase.leaked), false);
      return true;
    });
  }
});

test('QVaultClient preserves the explicit bounded batch reveal contract', async () => {
  const calls = [];
  const item = { secretId: secret.id, project: project.slug, environment: 'production', name: secret.name, value: 'local-only-batch-secret', version: secret.version, updatedAt: secret.updatedAt };
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ items: [item] }, 200, { 'cache-control': 'no-store' });
  } });
  const result = await client.revealSecrets({ secrets: [{ project: project.slug, environment: 'production', name: secret.name }], purpose: 'local batch test' });
  assert.deepEqual(result, { items: [item] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/vault/secrets/reveal-batch');
  assert.deepEqual(JSON.parse(calls[0].init.body), { secrets: [{ project: project.slug, environment: 'production', name: secret.name }], purpose: 'local batch test' });
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer qvt_test');
});

test('QVaultClient rejects malformed reveal payloads without echoing the response', async () => {
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async () => jsonResponse({ value: 'must-not-echo' }) });
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
  const client = new QVaultClient({ baseUrl: 'https://example.test', getAccessToken: () => 'jwt-test', fetchImplementation: async () => jsonResponse([event, userEvent]) });
  assert.deepEqual(await client.listAudit(), [event, userEvent]);

  const unsafeClient = new QVaultClient({
    baseUrl: 'https://example.test',
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
