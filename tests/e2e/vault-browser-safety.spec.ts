import { AxeBuilder } from '@axe-core/playwright';
import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';
import { apiJson, signInPage, signInSession } from './helpers';

const SECRET_ONE = 'local-e2e-browser-secret-one';
const SECRET_TWO = 'local-e2e-browser-secret-two';
const SECRET_OTHER_ENVIRONMENT = 'local-e2e-browser-secret-other-environment';
const RAW_ERROR_BODY = 'raw Vault response body must never be rendered';

type VaultProject = { id: string; slug: string; name: string };
type VaultEnvironment = { id: string; projectId: string; slug: string; name: string };
type VaultSecret = { id: string; projectId: string; environmentId: string; name: string; version: number };

function data<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Invalid Vault API response envelope.');
  return (body as { data: T }).data;
}

async function createProject(token: string, name: string, slug: string): Promise<VaultProject> {
  const response = await apiJson('/vault/projects', token, { method: 'POST', body: JSON.stringify({ name, slug }) });
  expect(response.response.status).toBe(201);
  return data<VaultProject>(response.body);
}

async function createEnvironment(token: string, project: VaultProject, name: string, slug: string): Promise<VaultEnvironment> {
  const response = await apiJson(`/vault/projects/${project.id}/environments`, token, { method: 'POST', body: JSON.stringify({ name, slug }) });
  expect(response.response.status).toBe(201);
  return data<VaultEnvironment>(response.body);
}

async function createSecret(token: string, project: VaultProject, environment: VaultEnvironment, name: string, value: string): Promise<VaultSecret> {
  const response = await apiJson(`/vault/environments/${environment.id}/secrets`, token, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, environmentId: environment.id, name, value, mutationId: crypto.randomUUID() }),
  });
  expect(response.response.status).toBe(201);
  return data<VaultSecret>(response.body);
}

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`).join('\n');
  expect(results.violations, `${label} accessibility violations\n${summary}`).toEqual([]);
}

async function expectNotPersisted(page: Page, needles: string[]): Promise<void> {
  const persisted = await page.evaluate(async () => {
    const values: string[] = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) values.push(key, storage.getItem(key) ?? '');
      }
    }

    const databaseList = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    for (const databaseInfo of databaseList) {
      if (!databaseInfo.name) continue;
      const databaseText = await new Promise<string>((resolve) => {
        const request = indexedDB.open(databaseInfo.name!);
        request.onerror = () => resolve('');
        request.onsuccess = () => {
          const database = request.result;
          const storeNames = Array.from(database.objectStoreNames);
          const records: string[] = [];
          if (!storeNames.length) {
            database.close();
            resolve('');
            return;
          }
          let remaining = storeNames.length;
          for (const storeName of storeNames) {
            const transaction = database.transaction(storeName, 'readonly');
            const cursorRequest = transaction.objectStore(storeName).openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              try { records.push(JSON.stringify(cursor.value)); } catch { /* Ignore non-serializable records. */ }
              cursor.continue();
            };
            const finish = () => {
              remaining -= 1;
              if (remaining === 0) {
                database.close();
                resolve(records.join('\n'));
              }
            };
            transaction.oncomplete = finish;
            transaction.onerror = finish;
            transaction.onabort = finish;
          }
        };
      });
      values.push(databaseInfo.name, databaseText);
    }

    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        values.push(request.url, await response?.clone().text().catch(() => '') ?? '');
      }
    }
    return values.join('\n');
  });

  for (const needle of needles) expect(persisted).not.toContain(needle);
}

async function installFailTwiceThenSuccess(page: Page, url: string, successBody: unknown, delayFirstRequest = false): Promise<void> {
  let attempts = 0;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    attempts += 1;
    if (delayFirstRequest && attempts === 1) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (attempts <= 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: RAW_ERROR_BODY } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: successBody }) });
  });
}

test.describe.configure({ timeout: 45_000 });

test('Vault collections distinguish loading, failure, empty, and safe retry states', async ({ page }) => {
  const session = await signInSession();
  const suffix = crypto.randomUUID();
  const project = await createProject(session.access_token, `Browser safety ${suffix}`, `browser-safety-${suffix.slice(0, 8)}`);
  const environment = await createEnvironment(session.access_token, project, 'Production', `production-${suffix.slice(0, 8)}`);
  const secret = await createSecret(session.access_token, project, environment, 'BROWSER_SAFETY_SECRET', SECRET_ONE);

  await installFailTwiceThenSuccess(page, '**/vault/projects', [project], true);
  await installFailTwiceThenSuccess(page, `**/vault/projects/${project.id}/environments`, [environment]);
  await installFailTwiceThenSuccess(page, `**/vault/environments/${environment.id}/secrets`, [secret]);
  await signInPage(page);

  const navigation = page.goto('/vault');
  await expect(page.getByText('Loading Vault projects…', { exact: true })).toBeVisible();
  await navigation;
  const projectCard = page.locator('.q-vault-grid > .q-card').first();
  await expect(projectCard.getByRole('alert')).toContainText('Unable to load Vault projects.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await expectAccessible(page, 'Vault project query failure');
  await projectCard.getByRole('button', { name: 'Retry', exact: true }).click();

  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  const environmentCard = page.locator('.q-vault-grid > .q-card').nth(1);
  await expect(environmentCard.getByRole('alert')).toContainText('Unable to load Vault environments.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await environmentCard.getByRole('button', { name: 'Retry', exact: true }).click();

  await expect(page.getByRole('heading', { name: `${environment.name} secrets`, exact: true })).toBeVisible();
  await expect(environmentCard.getByRole('alert')).toContainText('Unable to load Vault secrets.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await environmentCard.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.q-vault-secret').filter({ hasText: secret.name })).toBeVisible();

  await installFailTwiceThenSuccess(page, '**/vault/agent-tokens', []);
  await page.goto('/vault/agents');
  const tokenCard = page.locator('section.q-card').filter({ hasText: 'Issued tokens' });
  await expect(tokenCard.getByRole('alert')).toContainText('Unable to load Vault agent tokens.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await tokenCard.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(tokenCard).toContainText('No qvt agent tokens yet.');

  await installFailTwiceThenSuccess(page, '**/vault/audit', []);
  await page.goto('/vault/audit');
  const auditCard = page.locator('section.q-card').filter({ hasText: 'Vault audit history' });
  await expect(auditCard.getByRole('alert')).toContainText('Unable to load Vault audit history.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await auditCard.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(auditCard).toContainText('No Vault events yet.');
});

test('Vault reveals clear on replacement failure, environment change, navigation, and unmount without browser persistence', async ({ page }) => {
  const session = await signInSession();
  const suffix = crypto.randomUUID();
  const project = await createProject(session.access_token, `Reveal safety ${suffix}`, `reveal-safety-${suffix.slice(0, 8)}`);
  const production = await createEnvironment(session.access_token, project, 'Production', `production-${suffix.slice(0, 8)}`);
  const staging = await createEnvironment(session.access_token, project, 'Staging', `staging-${suffix.slice(0, 8)}`);
  const firstSecret = await createSecret(session.access_token, project, production, 'BROWSER_SECRET_ONE', SECRET_ONE);
  await createSecret(session.access_token, project, production, 'BROWSER_SECRET_TWO', SECRET_TWO);
  await createSecret(session.access_token, project, staging, 'BROWSER_SECRET_STAGING', SECRET_OTHER_ENVIRONMENT);

  const vaultResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/vault/')) vaultResponses.push(response.fromServiceWorker() ? 'service-worker' : 'network');
  });

  await signInPage(page);
  const serviceWorkerRegistered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return true;
  });
  expect(serviceWorkerRegistered).toBe(true);
  await page.reload();
  await expect(page.locator('.q-working-header h2')).toBeVisible();
  await page.goto('/vault');

  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  const firstRow = page.locator('.q-vault-secret').filter({ hasText: firstSecret.name });
  const secondRow = page.locator('.q-vault-secret').filter({ hasText: 'BROWSER_SECRET_TWO' });
  await expect(firstRow.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET_ONE);
  await expectAccessible(page, 'Vault masked project and secret state');

  await firstRow.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(firstRow.locator('code')).toHaveText(SECRET_ONE);
  await expectNotPersisted(page, [SECRET_ONE]);
  await expectAccessible(page, 'Vault revealed secret state');

  await page.getByRole('tab', { name: staging.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${staging.name} secrets`, exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET_ONE);
  await expectNotPersisted(page, [SECRET_ONE]);

  await page.getByRole('tab', { name: production.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${production.name} secrets`, exact: true })).toBeVisible();
  await firstRow.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(firstRow.locator('code')).toHaveText(SECRET_ONE);

  await page.route('**/vault/secrets/reveal', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: RAW_ERROR_BODY } }) });
  });
  await secondRow.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(page.locator('.q-toast-error')).toContainText('The value remains hidden.');
  await expect(page.locator('body')).not.toContainText(RAW_ERROR_BODY);
  await expect(firstRow.locator('code')).toHaveCount(0);
  await expect(secondRow.locator('code')).toHaveCount(0);
  await expectNotPersisted(page, [SECRET_ONE, SECRET_TWO]);
  await expectAccessible(page, 'Vault failed reveal state');
  await page.unroute('**/vault/secrets/reveal');

  await firstRow.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(firstRow.locator('code')).toHaveText(SECRET_ONE);
  await page.goto('/');
  await expect(page.locator('.q-working-header h2')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET_ONE);
  await expectNotPersisted(page, [SECRET_ONE, SECRET_TWO]);

  await page.goto('/vault/agents');
  await expect(page.getByRole('heading', { name: 'Agent credentials', exact: true })).toBeVisible();
  await page.getByLabel('Token name').fill('Browser safety token');
  await page.getByRole('button', { name: 'Add grant', exact: true }).click();
  await page.getByRole('button', { name: 'Create qvt token', exact: true }).click();
  const issuedToken = page.locator('.q-vault-issued[role="status"]');
  await expect(issuedToken).toBeVisible();
  const rawQvt = (await issuedToken.locator('code').textContent()) ?? '';
  expect(rawQvt).toMatch(/^qvt_[A-Za-z0-9_-]{43}$/);
  await expectNotPersisted(page, [SECRET_ONE, SECRET_TWO, SECRET_OTHER_ENVIRONMENT, rawQvt]);
  await expectAccessible(page, 'Vault one-time agent token state');
  await issuedToken.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('body')).not.toContainText(rawQvt);

  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vault audit history', exact: true })).toBeVisible();
  await expectAccessible(page, 'Vault audit state');
  expect(vaultResponses.length).toBeGreaterThan(0);
  expect(vaultResponses).not.toContain('service-worker');
});
