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

test('QVaultClient rejects malformed reveal payloads without echoing the response', async () => {
  const client = new QVaultClient({ baseUrl: 'http://example.test', getAccessToken: () => 'qvt_test', fetchImplementation: async () => jsonResponse({ value: 'must-not-echo' }) });
  await assert.rejects(() => client.revealSecret({ project: 'p', environment: 'e', name: 'KEY', purpose: 'test' }), (error) => {
    assert.ok(error instanceof QVaultProtocolError);
    assert.match(error.message, /malformed reveal/);
    assert.equal(error.message.includes('must-not-echo'), false);
    return true;
  });
});
