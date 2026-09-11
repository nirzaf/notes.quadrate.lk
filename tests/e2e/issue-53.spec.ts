import { test, expect } from './test-fixtures';
import { createNoteApi, expectPreviewMode, signInPage, signInSession } from './helpers';

function isNoteDetailRequest(url: string, noteId: string): boolean {
  return new URL(url).pathname.endsWith(`/api/notes/${noteId}`);
}

function isShareRequest(url: string, noteId: string): boolean {
  return new URL(url).pathname.endsWith(`/api/notes/${noteId}/share`);
}

test('does not request share metadata before the Share dialog is opened', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Issue 53 unopened share ${crypto.randomUUID()}`, 'Share metadata should be deferred.');
  const shareRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && isShareRequest(request.url(), note.id)) shareRequests.push(request.url());
  });

  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  await page.waitForTimeout(500);

  expect(shareRequests).toHaveLength(0);
});

test('prefetches one likely pointer target and navigation joins the detail request', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Issue 53 pointer ${crypto.randomUUID()}`, 'Pointer intent prefetch.');
  const detailRequests: string[] = [];
  const noteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' || !request.url().includes(`/api/notes/${note.id}`)) return;
    noteRequests.push(request.url());
    if (isNoteDetailRequest(request.url(), note.id)) detailRequests.push(request.url());
  });

  await signInPage(page);
  const card = page.locator('.q-note-card').filter({ hasText: note.title }).first();
  await card.hover();
  await expect.poll(() => detailRequests.length).toBe(1);
  expect(noteRequests.every((url) => isNoteDetailRequest(url, note.id))).toBe(true);

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expectPreviewMode(page);
  expect(detailRequests).toHaveLength(1);
});

test('keyboard focus receives the same bounded detail prefetch before navigation', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Issue 53 keyboard ${crypto.randomUUID()}`, 'Keyboard intent prefetch.');
  const detailRequests: string[] = [];
  const noteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' || !request.url().includes(`/api/notes/${note.id}`)) return;
    noteRequests.push(request.url());
    if (isNoteDetailRequest(request.url(), note.id)) detailRequests.push(request.url());
  });

  await signInPage(page);
  const card = page.locator('.q-note-card').filter({ hasText: note.title }).first();
  await card.focus();
  await expect.poll(() => detailRequests.length).toBe(1);
  expect(noteRequests.every((url) => isNoteDetailRequest(url, note.id))).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expectPreviewMode(page);
  expect(detailRequests).toHaveLength(1);
});

test('cold note navigation still fetches one detail and preserves back/forward history', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Issue 53 cold ${crypto.randomUUID()}`, 'Cold navigation.');
  const detailRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && isNoteDetailRequest(request.url(), note.id)) detailRequests.push(request.url());
  });

  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  expect(detailRequests).toHaveLength(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expectPreviewMode(page);
  expect(detailRequests).toHaveLength(1);
});

test('opened Share distinguishes loading, failure, retry, and no-share states', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Issue 53 share retry ${crypto.randomUUID()}`, 'Deferred share metadata.');
  let attempts = 0;
  let releaseFirstRequest: () => void = () => undefined;
  const firstRequestReleased = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
  await page.route(`**/functions/v1/qnotes-api/api/notes/${note.id}/share`, async (route) => {
    attempts += 1;
    if (attempts <= 2) {
      await firstRequestReleased;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SHARE_UNAVAILABLE', message: 'Share service is temporarily unavailable.', requestId: 'issue-53-test' } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) });
  });

  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  const dialog = page.getByRole('dialog');
  expect(await page.locator('.q-public-share-dialog').count()).toBe(0);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('Checking the current link');
  releaseFirstRequest();
  await expect(dialog.getByRole('alert')).toContainText('Unable to check the current public link');
  await expect(dialog.getByRole('alert')).toContainText('Share service is temporarily unavailable.');

  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog).toContainText('The link contains a secret that is shown once.');
  expect(attempts).toBe(3);
});
