import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, signInPage, signInSession } from './helpers';

test('mobile Home keeps the branded shell, URL-backed filters, and note actions usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Mobile home ${crypto.randomUUID()}`, 'Mobile card fixture.');
  const notebookResponse = await apiJson('/api/notebooks', session.access_token, { method: 'POST', body: JSON.stringify({ name: `Mobile ${crypto.randomUUID().slice(0, 8)}` }) });
  expect(notebookResponse.response.ok).toBe(true);
  const notebook = (notebookResponse.body as { data: { id: string; name: string } }).data;

  await signInPage(page);
  await expect(page.locator('.q-sidebar')).toBeHidden();
  await expect(page.locator('.q-mobile-brand img')).toHaveAttribute('src', '/icon.svg');
  await expect(page.getByText('Your thoughts, organized')).toBeVisible();
  await expect(page.locator('.q-home-hero')).toContainText('All notes');
  await expect(page.locator('.q-home-hero').getByRole('button', { name: 'New note' })).toBeVisible();
  await expect(page.locator('.q-note-card').filter({ hasText: note.title })).toBeVisible();
  await expect(page.locator('.q-note-item-icon').first()).toBeVisible();
  await expect(page.getByText('Recently updated')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Filter search by tag' })).toBeVisible();

  await page.getByRole('button', { name: 'Hide search filters' }).click();
  await expect(page.getByRole('textbox', { name: 'Filter search by tag' })).toBeHidden();
  await page.getByRole('button', { name: 'Show search filters' }).click();
  await expect(page.getByRole('combobox', { name: 'Filter search by source' })).toBeVisible();

  await expect(page.getByRole('button', { name: notebook.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: notebook.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]notebook=${notebook.id}`));
  await expect(page.locator('.q-home-hero')).toContainText(notebook.name);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.q-home-hero')).toContainText('All notes');

  await page.getByRole('textbox', { name: 'Filter search by tag' }).fill('mobile');
  await expect(page).toHaveURL(/[?&]tag=mobile/);
  await page.getByRole('combobox', { name: 'Filter search by source' }).selectOption('note_chunk');
  await expect(page).toHaveURL(/[?&]source=note_chunk/);

  await page.locator('.q-mobile-header-action[aria-label="Search notes"]').click();
  await expect(page).toHaveURL(/\/search/);
  await page.locator('.q-mobile-nav-item').filter({ hasText: 'Notes' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('.q-mobile-header-action[aria-label="Open menu"]').click();
  await expect(page.getByRole('dialog')).toContainText('More workspace tools');
  await page.keyboard.press('Escape');

  await page.locator('.q-home-hero').getByRole('button', { name: 'New note' }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  await page.locator('.q-mobile-nav-item').filter({ hasText: 'Notes' }).click();
  await page.locator('.q-floating-new').click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);

  await page.locator('.q-mobile-nav-item').filter({ hasText: 'Notes' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(() => page.locator('.q-main-body').evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom))).toBeGreaterThanOrEqual(140);
});

test('mobile Home remains usable at the narrowest supported viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await signInPage(page);
  await expect(page.locator('.q-mobile-brand')).toBeVisible();
  await expect(page.locator('.q-home-hero')).toBeVisible();
  await expect(page.locator('.q-mobile-collections')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
