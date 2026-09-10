import { AxeBuilder } from '@axe-core/playwright';
import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';
import { apiJson, createNoteApi, createPublicShareApi, expectEditorMode, expectPreviewMode, signInPage, signInSession } from './helpers';

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`).join('\n');
  expect(results.violations, `${label} accessibility violations\n${summary}`).toEqual([]);
}

type VaultAccessibilityFixture = { project: { id: string; name: string }; environment: { id: string; name: string } };

function vaultData<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Invalid Vault API response envelope.');
  return (body as { data: T }).data;
}

async function createVaultAccessibilityFixture(token: string): Promise<VaultAccessibilityFixture> {
  const suffix = crypto.randomUUID();
  const projectResponse = await apiJson('/vault/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: `Vault accessibility ${suffix}`, slug: `vault-a11y-${suffix.slice(0, 8)}` }),
  });
  expect(projectResponse.response.status).toBe(201);
  const project = vaultData<{ id: string; name: string }>(projectResponse.body);

  const environmentResponse = await apiJson(`/vault/projects/${project.id}/environments`, token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Accessibility staging', slug: `a11y-${suffix.slice(0, 8)}` }),
  });
  expect(environmentResponse.response.status).toBe(201);
  const environment = vaultData<{ id: string; name: string }>(environmentResponse.body);

  const secretResponse = await apiJson(`/vault/environments/${environment.id}/secrets`, token, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, environmentId: environment.id, name: 'A11Y_SYNTHETIC_SECRET', value: `synthetic-a11y-${suffix}`, mutationId: crypto.randomUUID() }),
  });
  expect(secretResponse.response.status).toBe(201);
  return { project, environment };
}

test('Vault pages and sensitive states have no automated accessibility violations', async ({ page }) => {
  const session = await signInSession();
  const fixture = await createVaultAccessibilityFixture(session.access_token);

  await signInPage(page);
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: fixture.project.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: `${fixture.environment.name} secrets`, exact: true })).toBeVisible();
  await expectAccessible(page, 'Vault projects');

  const secretRow = page.locator('.q-vault-secret').filter({ hasText: 'A11Y_SYNTHETIC_SECRET' });
  await secretRow.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(secretRow.locator('code')).toBeVisible();
  await expectAccessible(page, 'Vault revealed secret');
  await secretRow.getByRole('button', { name: 'Hide', exact: true }).click();

  await page.getByRole('link', { name: 'Agent tokens', exact: true }).click();
  await expect(page).toHaveURL(/\/vault\/agents$/);
  await expect(page.getByRole('heading', { name: 'Agent credentials', exact: true })).toBeVisible();
  await page.getByLabel('Token name').fill('Accessibility synthetic qvt');
  await page.getByLabel('Grant scope').selectOption('environment');
  await page.getByLabel('Environment').selectOption(fixture.environment.id);
  await page.getByLabel('Action').selectOption('secret:reveal');
  await page.getByRole('button', { name: 'Add grant', exact: true }).click();
  await expect(page.getByRole('list', { name: 'New token grants', exact: true })).toHaveCount(1);
  await expectAccessible(page, 'Vault agent grant draft');

  await page.getByRole('button', { name: 'Create qvt token', exact: true }).click();
  const issuedToken = page.locator('.q-vault-issued[role="status"]');
  await expect(issuedToken).toBeVisible();
  await expect(issuedToken.locator('code')).toHaveText(/^qvt_[A-Za-z0-9_-]{43}$/);
  await expectAccessible(page, 'Vault one-time qvt display');
  await issuedToken.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await expect(page).toHaveURL(/\/vault\/audit$/);
  await expect(page.getByRole('heading', { name: 'Vault audit history', exact: true })).toBeVisible();
  await expectAccessible(page, 'Vault audit');
});

test('mobile Home has no automated accessibility violations and its menu is keyboard operable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await signInSession();
  await createNoteApi(session.access_token, `Accessibility Home ${crypto.randomUUID()}`, 'Keyboard and accessibility fixture.');
  await signInPage(page);
  await expectAccessible(page, 'mobile Home');

  const menuButton = page.locator('.q-mobile-header-action[aria-label="Open menu"]');
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(menuButton).toBeFocused();
});

test('keyboard smoke covers collection chips, filters, search results, and dialog focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await signInSession();
  const marker = `keyboard-${crypto.randomUUID()}`;
  await createNoteApi(session.access_token, `Keyboard first ${marker}`, `First ${marker}.`);
  await createNoteApi(session.access_token, `Keyboard second ${marker}`, `Second ${marker}.`);
  const notebookResponse = await apiJson('/api/notebooks', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: `Keyboard ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(notebookResponse.response.ok).toBe(true);
  const notebook = (notebookResponse.body as { data: { id: string; name: string } }).data;

  await signInPage(page);
  const searchHeaderAction = page.getByRole('link', { name: 'Search notes' });
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  await searchHeaderAction.focus();
  await page.keyboard.press('Tab');
  await expect(menuButton).toBeFocused();
  await page.keyboard.press('Enter');
  const moreDialog = page.getByRole('dialog');
  await expect(moreDialog).toBeVisible();
  await moreDialog.getByRole('button', { name: 'Close' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(moreDialog).toBeHidden();
  await expect(menuButton).toBeFocused();

  const notebookChip = page.getByRole('button', { name: notebook.name, exact: true });
  await notebookChip.focus();
  await expect(notebookChip).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(new RegExp(`[?&]notebook=${notebook.id}`));

  const hideFilters = page.getByRole('button', { name: 'Hide search filters' });
  await hideFilters.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Show search filters' })).toBeVisible();
  const showFilters = page.getByRole('button', { name: 'Show search filters' });
  await showFilters.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Filter search by tag' })).toBeVisible();

  await page.goto('/search');
  const search = page.getByRole('textbox', { name: 'Search notes' }).first();
  await search.fill(marker);
  await search.press('Enter');
  const results = page.locator('.q-search-result-main');
  await expect.poll(() => results.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const firstResult = results.nth(0);
  const secondResult = results.nth(1);
  await firstResult.focus();
  await page.keyboard.press('ArrowDown');
  await expect(secondResult).toBeFocused();
  await page.keyboard.press('Home');
  await expect(firstResult).toBeFocused();
});

test('search and note editor remain accessible through edit and preview views', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Accessibility Search ${crypto.randomUUID()}`, '# Accessibility fixture\n\nSearchable body.');
  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' }).first();
  await search.fill('Accessibility fixture');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/search/);
  await expectAccessible(page, 'search');

  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  await expectAccessible(page, 'note preview');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectEditorMode(page);
  await expectAccessible(page, 'note editor');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expectPreviewMode(page);
  await expectAccessible(page, 'note preview');
});

test('public share view has no accessibility violations', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Accessibility Share ${crypto.randomUUID()}`, '# Public accessibility fixture');
  const share = await createPublicShareApi(session.access_token, note);
  await page.goto(`/share#${share.token}`);
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();
  await expect(page.locator('.q-attachment-panel')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expectAccessible(page, 'public share');
});
