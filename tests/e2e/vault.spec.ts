import { test, expect } from './test-fixtures';
import { apiJson, signInPage, signInSession } from './helpers';

const FAKE_SECRET = 'local-e2e-vault-value';
const SECRET_NAME = 'CLOUDFLARE_API_TOKEN';

type VaultProject = { id: string; slug: string; name: string };
type VaultEnvironment = { id: string; projectId: string; slug: string; name: string };
type VaultSecret = { id: string; projectId: string; environmentId: string; name: string; version: number };

function data<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Invalid API response envelope.');
  return (body as { data: T }).data;
}

async function createFixture(token: string): Promise<{ project: VaultProject; environment: VaultEnvironment; secret: VaultSecret }> {
  const projectResponse = await apiJson('/vault/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: `Vault E2E ${crypto.randomUUID()}`, slug: `vault-e2e-${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(projectResponse.response.status).toBe(201);
  const project = data<VaultProject>(projectResponse.body);

  const environmentResponse = await apiJson(`/vault/projects/${project.id}/environments`, token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Production', slug: 'production' }),
  });
  expect(environmentResponse.response.status).toBe(201);
  const environment = data<VaultEnvironment>(environmentResponse.body);

  const secretResponse = await apiJson(`/vault/environments/${environment.id}/secrets`, token, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, environmentId: environment.id, name: SECRET_NAME, value: FAKE_SECRET, mutationId: crypto.randomUUID() }),
  });
  expect(secretResponse.response.status).toBe(201);
  const secret = data<VaultSecret>(secretResponse.body);
  return { project, environment, secret };
}

test('keeps Vault values out of metadata, Notes search, and audit responses', async () => {
  const session = await signInSession();
  const fixture = await createFixture(session.access_token);

  const listed = await apiJson(`/vault/environments/${fixture.environment.id}/secrets`, session.access_token);
  expect(listed.response.status).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain(FAKE_SECRET);
  expect(JSON.stringify(listed.body)).toContain(SECRET_NAME);

  const revealed = await apiJson('/vault/secrets/reveal', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ project: fixture.project.slug, environment: fixture.environment.slug, name: SECRET_NAME, purpose: 'Local E2E reveal verification' }),
  });
  expect(revealed.response.status).toBe(200);
  expect(revealed.response.headers.get('cache-control')).toBe('no-store');
  expect(revealed.response.headers.get('pragma')).toBe('no-cache');
  expect(revealed.response.headers.get('x-content-type-options')).toBe('nosniff');
  expect((data<{ value: string }>(revealed.body)).value).toBe(FAKE_SECRET);

  const search = await apiJson(`/api/search?query=${encodeURIComponent(FAKE_SECRET)}&mode=keyword`, session.access_token);
  expect(search.response.status).toBe(200);
  expect(JSON.stringify(search.body)).not.toContain(FAKE_SECRET);

  const audit = await apiJson('/vault/audit', session.access_token);
  expect(audit.response.status).toBe(200);
  expect(JSON.stringify(audit.body)).not.toContain(FAKE_SECRET);
  expect(JSON.stringify(audit.body)).toContain('secret:reveal');
});

test('enforces qvt grants and isolates qnt and qns credentials', async ({ page }) => {
  const session = await signInSession();
  const fixture = await createFixture(session.access_token);
  const secondResponse = await apiJson(`/vault/environments/${fixture.environment.id}/secrets`, session.access_token, {
    method: 'POST',
    body: JSON.stringify({ projectId: fixture.project.id, environmentId: fixture.environment.id, name: 'UNAUTHORIZED_SECRET', value: FAKE_SECRET, mutationId: crypto.randomUUID() }),
  });
  expect(secondResponse.response.status).toBe(201);

  const tokenResponse = await apiJson('/vault/agent-tokens', session.access_token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Local E2E reveal agent',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      grants: [{ projectId: fixture.project.id, environmentId: fixture.environment.id, secretId: fixture.secret.id, action: 'secret:reveal' }],
    }),
  });
  expect(tokenResponse.response.status).toBe(201);
  const tokenData = data<{ token: string; metadata: { id: string; tokenPrefix: string } }>(tokenResponse.body);
  expect(tokenData.token).toMatch(/^qvt_[A-Za-z0-9_-]{43}$/);
  expect(tokenData.metadata.tokenPrefix).toMatch(/^qvt_[A-Za-z0-9_-]{8}$/);

  const allowed = await apiJson('/vault/secrets/reveal', tokenData.token, {
    method: 'POST',
    body: JSON.stringify({ project: fixture.project.slug, environment: fixture.environment.slug, name: SECRET_NAME, purpose: 'Local E2E exact grant verification' }),
  });
  expect(allowed.response.status).toBe(200);
  expect((data<{ value: string }>(allowed.body)).value).toBe(FAKE_SECRET);

  const denied = await apiJson('/vault/secrets/reveal', tokenData.token, {
    method: 'POST',
    body: JSON.stringify({ project: fixture.project.slug, environment: fixture.environment.slug, name: 'UNAUTHORIZED_SECRET', purpose: 'Local E2E denied grant verification' }),
  });
  expect(denied.response.status).toBe(403);
  expect(JSON.stringify(denied.body)).not.toContain(FAKE_SECRET);

  const auditResponse = await apiJson('/vault/audit', session.access_token);
  expect(auditResponse.response.status).toBe(200);
  const auditEvents = data<Array<{ actorKind: string; actorTokenName: string | null; actorTokenPrefix: string | null; action: string; success: boolean; resultCode: string | null }>>(auditResponse.body);
  const deniedAudit = auditEvents.find((event) => event.action === 'secret:reveal' && event.resultCode === 'access_denied' && !event.success);
  expect(deniedAudit).toEqual(expect.objectContaining({ actorKind: 'vault_agent', actorTokenName: 'Local E2E reveal agent', actorTokenPrefix: tokenData.metadata.tokenPrefix, success: false, resultCode: 'access_denied' }));
  expect(JSON.stringify(auditResponse.body)).not.toContain(tokenData.token);
  expect(JSON.stringify(auditResponse.body)).not.toContain(FAKE_SECRET);

  await signInPage(page);
  await page.goto('/vault/audit');
  await expect(page.getByText('Local E2E reveal agent', { exact: false })).toBeVisible();
  await expect(page.getByText(tokenData.metadata.tokenPrefix, { exact: true })).toBeVisible();

  const qntResponse = await apiJson('/api/tokens', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Local E2E Notes token', scopes: ['notes:read'], expiresAt: null }),
  });
  const qnt = data<{ token: string }>(qntResponse.body).token;
  expect((await apiJson('/vault/projects', qnt)).response.status).toBe(401);
  expect((await apiJson('/api/notes', tokenData.token)).response.status).toBe(401);
  expect((await apiJson('/vault/projects', `qns_${'a'.repeat(43)}`)).response.status).toBe(401);

  const revoked = await apiJson(`/vault/agent-tokens/${data<{ metadata: { id: string } }>(tokenResponse.body).metadata.id}`, session.access_token, { method: 'DELETE' });
  expect(revoked.response.status).toBe(200);
  expect((await apiJson('/vault/secrets/reveal', tokenData.token, {
    method: 'POST',
    body: JSON.stringify({ project: fixture.project.slug, environment: fixture.environment.slug, name: SECRET_NAME, purpose: 'Local E2E revoked-token verification' }),
  })).response.status).toBe(401);
});

test('lists effective multiple grants and replaces them without plaintext or raw qvt metadata', async () => {
  const session = await signInSession();
  const fixture = await createFixture(session.access_token);
  const grants = [
    { projectId: fixture.project.id, environmentId: null, secretId: null, action: 'metadata:read' },
    { projectId: fixture.project.id, environmentId: fixture.environment.id, secretId: fixture.secret.id, action: 'secret:reveal' },
  ];
  const created = await apiJson('/vault/agent-tokens', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Multi-grant contract token', expiresAt: null, grants }),
  });
  expect(created.response.status).toBe(201);
  const createdData = data<{ token: string; metadata: { id: string } }>(created.body);
  expect(createdData.token).toMatch(/^qvt_[A-Za-z0-9_-]{43}$/);

  const listed = await apiJson('/vault/agent-tokens', session.access_token);
  expect(listed.response.status).toBe(200);
  const listedToken = data<Array<{ id: string; grants: Array<Record<string, unknown>> }>>(listed.body).find((token) => token.id === createdData.metadata.id);
  expect(listedToken?.grants).toHaveLength(2);
  expect(listedToken?.grants).toEqual(expect.arrayContaining([
    expect.objectContaining({ projectId: fixture.project.id, projectName: fixture.project.name, environmentId: null, secretId: null, action: 'metadata:read' }),
    expect.objectContaining({ projectId: fixture.project.id, projectName: fixture.project.name, environmentId: fixture.environment.id, environmentName: fixture.environment.name, secretId: fixture.secret.id, secretName: fixture.secret.name, action: 'secret:reveal' }),
  ]));
  expect(listedToken?.grants.every((grant) => !('value' in grant))).toBe(true);
  expect(JSON.stringify(listed.body)).not.toContain(createdData.token);
  expect(JSON.stringify(listed.body)).not.toContain(FAKE_SECRET);

  const replaced = await apiJson(`/vault/agent-tokens/${createdData.metadata.id}/grants`, session.access_token, {
    method: 'PATCH',
    body: JSON.stringify({ grants: [grants[0]] }),
  });
  expect(replaced.response.status).toBe(200);
  expect(data<Array<Record<string, unknown>>>(replaced.body)).toEqual([
    expect.objectContaining({ projectId: fixture.project.id, environmentId: null, secretId: null, action: 'metadata:read' }),
  ]);

  const cleared = await apiJson(`/vault/agent-tokens/${createdData.metadata.id}/grants`, session.access_token, {
    method: 'PATCH',
    body: JSON.stringify({ grants: [] }),
  });
  expect(cleared.response.status).toBe(200);
  expect(data<unknown[]>(cleared.body)).toEqual([]);
});

test('lets the Vault UI draft multiple grants, remove drafts, and clear an existing token', async ({ page }) => {
  const session = await signInSession();
  const fixture = await createFixture(session.access_token);
  await signInPage(page);
  await page.goto('/vault/agents');
  await expect(page.getByRole('heading', { name: 'Agent credentials', exact: true })).toBeVisible();

  await page.getByLabel('Token name').fill('UI multi-grant token');
  await page.getByLabel('Project').selectOption(fixture.project.id);
  await page.getByLabel('Grant scope').selectOption('project');
  await page.getByRole('button', { name: 'Add grant', exact: true }).click();
  await page.getByLabel('Grant scope').selectOption('environment');
  await page.getByLabel('Environment').selectOption(fixture.environment.id);
  await page.getByLabel('Action').selectOption('secret:reveal');
  await page.getByRole('button', { name: 'Add grant', exact: true }).click();
  await expect(page.locator('#new-token-grants-heading').locator('..')).toContainText('2');
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: 'Create qvt token', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Copy this token now');
  const issued = await page.getByRole('status').locator('code').textContent();
  expect(issued).toMatch(/^qvt_[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);

  const tokenCard = page.getByRole('article').filter({ hasText: 'UI multi-grant token' });
  await expect(tokenCard).toContainText('Effective grants (1)');
  await tokenCard.getByRole('button', { name: 'Edit grants', exact: true }).click();
  await expect(tokenCard).toContainText('Edit grant set (1)');
  await tokenCard.getByRole('button', { name: 'Remove', exact: true }).click();
  await tokenCard.getByRole('button', { name: 'Replace grant set', exact: true }).click();
  await expect(tokenCard).toContainText('No grants. This token cannot access Vault resources.');
});

test('supports replay-safe rotation and explicit bounded batch reveal', async () => {
  const session = await signInSession();
  const fixture = await createFixture(session.access_token);
  const mutationId = crypto.randomUUID();
  const rotateInput = { value: 'local-e2e-rotated-value', expectedVersion: fixture.secret.version, mutationId };
  const first = await apiJson(`/vault/secrets/${fixture.secret.id}`, session.access_token, { method: 'PATCH', body: JSON.stringify(rotateInput) });
  expect(first.response.status).toBe(200);
  expect(data<VaultSecret>(first.body).version).toBe(fixture.secret.version + 1);
  const replay = await apiJson(`/vault/secrets/${fixture.secret.id}`, session.access_token, { method: 'PATCH', body: JSON.stringify(rotateInput) });
  expect(replay.response.status).toBe(200);
  expect(data<VaultSecret>(replay.body).version).toBe(fixture.secret.version + 1);
  const reuse = await apiJson(`/vault/secrets/${fixture.secret.id}`, session.access_token, { method: 'PATCH', body: JSON.stringify({ ...rotateInput, value: 'local-e2e-different-value' }) });
  expect(reuse.response.status).toBe(409);

  const batch = await apiJson('/vault/secrets/reveal-batch', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ secrets: [{ project: fixture.project.slug, environment: fixture.environment.slug, name: SECRET_NAME }], purpose: 'Local E2E bounded batch verification' }),
  });
  expect(batch.response.status).toBe(200);
  expect((data<{ items: Array<{ value: string }> }>(batch.body)).items[0]?.value).toBe('local-e2e-rotated-value');

  const staleDelete = await apiJson(`/vault/secrets/${fixture.secret.id}`, session.access_token, { method: 'DELETE', body: JSON.stringify({ expectedVersion: fixture.secret.version, mutationId: crypto.randomUUID(), confirm: true }) });
  expect(staleDelete.response.status).toBe(409);

  const auditResponse = await apiJson('/vault/audit', session.access_token);
  expect(auditResponse.response.status).toBe(200);
  const auditEvents = data<Array<{ actorKind: string; actorTokenId: string | null; action: string; secretId: string | null; success: boolean; resultCode: string | null }>>(auditResponse.body);
  expect(auditEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ actorKind: 'user_jwt', actorTokenId: null, action: 'secret:write', secretId: fixture.secret.id, success: false, resultCode: 'mutation_reuse_conflict' }),
    expect.objectContaining({ actorKind: 'user_jwt', actorTokenId: null, action: 'secret:delete', secretId: fixture.secret.id, success: false, resultCode: 'version_conflict' }),
  ]));
  expect(JSON.stringify(auditResponse.body)).not.toContain('local-e2e-rotated-value');
});
