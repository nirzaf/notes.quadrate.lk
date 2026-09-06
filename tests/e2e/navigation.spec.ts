import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';
import { createNoteApi, getNoteApi, OWNER, signInPage, signInSession } from './helpers';

function capturePageErrors(page: Page): () => void {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return () => {
    expect(errors.map((error) => error.message).join('\n')).not.toMatch(/Cannot read properties of undefined|Unhandled|unhandled/i);
    expect(errors).toHaveLength(0);
  };
}

test('keeps Home, note, Tokens, and native Back/Forward transitions usable', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Navigation ${crypto.randomUUID()}`, 'Navigation fixture.');
  const assertNoPageErrors = capturePageErrors(page);

  await signInPage(page);
  await page.locator('.q-note-card').filter({ hasText: note.title }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expect(page.locator('.cm-content')).toContainText('Navigation fixture.');
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Navigation fixture.');
  await page.goBack();
  await expect(page.locator('.q-working-header h2')).toBeVisible();
  await expect(page.locator('.q-note-card').filter({ hasText: note.title })).toBeVisible();
  await page.goForward();
  await expect(page.locator('.cm-content')).toContainText('Navigation fixture.');
  await page.goBack();

  await page.getByRole('link', { name: 'Integrations' }).first().click();
  await expect(page).toHaveURL(/\/settings\/integrations$/);
  await expect(page.getByRole('heading', { name: /Connect Hermes/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /Connect Hermes/ })).toBeVisible();
  await page.goBack();
  await expect(page.locator('.q-working-header h2')).toBeVisible();
  assertNoPageErrors();
});

test('does not move a delayed A save or its newer edit into B', async ({ page }) => {
  const session = await signInSession(OWNER);
  const noteA = await createNoteApi(session.access_token, `Race A ${crypto.randomUUID()}`, 'A baseline.');
  const noteB = await createNoteApi(session.access_token, `Race B ${crypto.randomUUID()}`, 'B baseline.');
  const assertNoPageErrors = capturePageErrors(page);
  let releaseFirstPatch!: () => void;
  const firstPatchReleased = new Promise<void>((resolve) => { releaseFirstPatch = resolve; });
  let patchCount = 0;
  await page.route('**/functions/v1/qnotes-api/api/notes/**', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    patchCount += 1;
    const response = await route.fetch();
    if (patchCount === 1) await firstPatchReleased;
    await route.fulfill({ response });
  });

  await signInPage(page);
  await page.locator('.q-note-card').filter({ hasText: noteA.title }).click();
  const firstPatchStarted = page.waitForRequest((request) => request.url().includes(`/api/notes/${noteA.id}`) && request.method() === 'PATCH');
  await page.locator('.cm-content').fill('A first revision.\n');
  await firstPatchStarted;
  await page.locator('.cm-content').fill('A second revision while A is saving.\n');
  const selectB = page.locator('.q-note-list .q-note-item').filter({ hasText: noteB.title });
  const navigation = selectB.click();
  releaseFirstPatch();
  await navigation;
  await expect(page).toHaveURL(new RegExp(`/notes/${noteB.id}$`));
  await expect(page.locator('.cm-content')).toContainText('B baseline.');
  await page.locator('.cm-content').fill('B final revision.\n');
  await expect.poll(() => getNoteApi(session.access_token, noteB.id), { timeout: 10_000 }).toMatchObject({ contentMarkdown: 'B final revision.\n' });
  await page.locator('.q-note-list .q-note-item').filter({ hasText: noteA.title }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteA.id}$`));
  await expect(page.locator('.cm-content')).toContainText('A second revision while A is saving.');
  await expect.poll(() => getNoteApi(session.access_token, noteA.id), { timeout: 10_000 }).toMatchObject({ contentMarkdown: 'A second revision while A is saving.\n' });
  expect(await getNoteApi(session.access_token, noteB.id)).toMatchObject({ contentMarkdown: 'B final revision.\n' });
  assertNoPageErrors();
  await page.unroute('**/functions/v1/qnotes-api/api/notes/**');
});

test('New note from the integrations page is a real mutation and navigation', async ({ page }) => {
  const assertNoPageErrors = capturePageErrors(page);
  await signInPage(page);
  await page.getByRole('link', { name: 'Integrations' }).first().click();
  await page.getByRole('button', { name: 'Create a new note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  await expect(page.locator('.cm-content')).toBeVisible();
  assertNoPageErrors();
});

test('offers a starter note for an empty workspace and clears search quickly', async ({ page }) => {
  await signInPage(page);
  await expect(page.getByRole('heading', { name: 'Make your first note' })).toBeVisible();
  await page.getByRole('button', { name: 'Use starter note' }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  await expect(page.locator('.cm-content')).toContainText('private Markdown workspace');
  await expect(page.getByRole('status')).toContainText(/Saved/);

  await page.getByRole('link', { name: 'Quadrate Notes home' }).click();
  const search = page.getByRole('textbox', { name: 'Search notes' }).first();
  await search.fill('private Markdown workspace');
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(page).toHaveURL(/\/$/);
});

test('restores submitted search context after opening a result and refreshing', async ({ page }) => {
  const session = await signInSession();
  const marker = `search-${crypto.randomUUID()}`;
  const note = await createNoteApi(session.access_token, `Search ${marker}`, `Body ${marker}.`);
  const assertNoPageErrors = capturePageErrors(page);
  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' }).first();
  await search.fill(marker);
  await search.press('Enter');
  await expect(page).toHaveURL(new RegExp(`[?&]q=${marker}`));
  const matchingResult = page.locator('.q-search-result').filter({ hasText: note.title }).first();
  await expect(matchingResult).toBeVisible({ timeout: 15_000 });
  await matchingResult.getByRole('button', { name: 'Open matching section' }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}`));
  await page.goBack();
  await expect(search).toHaveValue(marker);
  await page.reload();
  await expect(search).toHaveValue(marker);
  assertNoPageErrors();
});
