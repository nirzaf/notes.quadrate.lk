import { AxeBuilder } from '@axe-core/playwright';
import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';
import { apiJson, createNoteApi, createPublicShareApi, expectEditorMode, expectPreviewMode, signInPage, signInSession } from './helpers';

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`).join('\n');
  expect(results.violations, `${label} accessibility violations\n${summary}`).toEqual([]);
}

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
  const share = await createPublicShareApi(session.access_token, note.id);
  await page.goto(`/share#${share.token}`);
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();
  await expect(page.locator('.q-attachment-panel')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expectAccessible(page, 'public share');
});
