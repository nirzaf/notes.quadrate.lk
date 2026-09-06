import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, createPublicShareApi, getNoteApi, OWNER, resolvePublicShareApi, resolvePublicShareMarkdownApi, signInPage, signInSession } from './helpers';

function data(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || !('data' in body) || !body.data || typeof body.data !== 'object') throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  return body.data as Record<string, unknown>;
}

test('renders a saved note publicly through the fragment without private API requests', async ({ browser }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Public view ${crypto.randomUUID()}`, '# Public heading\n\nPublic marker 4127.');
  const share = await createPublicShareApi(session.access_token, note.id);
  const context = await browser.newContext();
  const page = await context.newPage();
  const functionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/functions/v1/qnotes-api/')) functionRequests.push(request.url());
  });

  const resolved = await resolvePublicShareApi(share.token);
  expect(resolved.response.status).toBe(200);
  expect(data(resolved.body)).toEqual({ title: note.title, contentMarkdown: '# Public heading\n\nPublic marker 4127.', updatedAt: expect.any(String) });
  expect(resolved.response.headers.get('cache-control')).toBe('no-store');

  const markdown = await resolvePublicShareMarkdownApi(share.token);
  expect(markdown.response.status).toBe(200);
  expect(markdown.response.headers.get('content-type')).toContain('text/markdown');
  expect(markdown.response.headers.get('content-disposition')).toBe('inline; filename="shared-note.md"');
  expect(markdown.response.headers.get('x-robots-tag')).toContain('noindex');
  expect(markdown.response.headers.get('access-control-allow-origin')).toBe('*');
  expect(markdown.body).toBe('# Public heading\n\nPublic marker 4127.');

  await page.goto(`/share#${share.token}`);
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();
  await expect(page.locator('.q-public-share-note')).toContainText('Public marker 4127.');
  await expect(page.locator('.q-attachment-panel')).toHaveCount(0);
  expect(functionRequests.every((url) => url.endsWith('/public/share/resolve'))).toBe(true);
  const resolver = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/public/share/resolve')) ?? null);
  expect(resolver).not.toBeNull();
  await context.close();
});

test('rotates and revokes links while keeping the old secret unusable', async () => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Share rotation ${crypto.randomUUID()}`, 'Rotation body.');
  const first = await createPublicShareApi(session.access_token, note.id);
  const second = await createPublicShareApi(session.access_token, note.id);
  expect(second.token).not.toBe(first.token);
  expect((await resolvePublicShareApi(first.token)).response.status).toBe(404);
  expect((await resolvePublicShareApi(second.token)).response.status).toBe(200);
  expect((await resolvePublicShareMarkdownApi(second.token)).response.status).toBe(200);
  const revoked = await apiJson(`/api/notes/${note.id}/share`, session.access_token, { method: 'DELETE' });
  expect(revoked.response.status).toBe(200);
  expect((await resolvePublicShareApi(second.token)).response.status).toBe(404);
  expect((await resolvePublicShareMarkdownApi(second.token)).response.status).toBe(404);
});

test('soft deletion revokes a link permanently across restore', async () => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Share delete ${crypto.randomUUID()}`, 'Deletion body.');
  const share = await createPublicShareApi(session.access_token, note.id);
  const deleted = await apiJson(`/api/notes/${note.id}`, session.access_token, { method: 'DELETE', body: JSON.stringify({ expectedVersion: note.version, deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }) });
  expect(deleted.response.status).toBe(200);
  expect((await resolvePublicShareApi(share.token)).response.status).toBe(404);
  const deletedNote = await getNoteApi(session.access_token, note.id, true);
  const restored = await apiJson(`/api/notes/${note.id}/restore`, session.access_token, { method: 'POST', body: JSON.stringify({ expectedVersion: deletedNote.version, deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }) });
  expect(restored.response.status).toBe(200);
  expect((await resolvePublicShareApi(share.token)).response.status).toBe(404);
});

test('personal qnt tokens cannot manage or resolve public shares', async () => {
  const session = await signInSession(OWNER);
  const note = await createNoteApi(session.access_token, `Share token boundary ${crypto.randomUUID()}`, 'Boundary body.');
  const tokenResponse = await apiJson('/api/tokens', session.access_token, { method: 'POST', body: JSON.stringify({ name: `share-boundary-${crypto.randomUUID()}`, scopes: ['notes:read'], expiresAt: null }) });
  const personalToken = String(data(tokenResponse.body).token);
  const ownerAttempt = await apiJson(`/api/notes/${note.id}/share`, personalToken, { method: 'POST', body: JSON.stringify({ expiresAt: null }) });
  expect(ownerAttempt.response.status).toBe(403);
  expect((await resolvePublicShareApi(personalToken)).response.status).toBe(404);
});

test('share dialog shows the raw link once and safe metadata after reopening', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Share dialog ${crypto.randomUUID()}`, 'Dialog body.');
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Create public link' }).click();
  await expect(dialog).toContainText('Public link created');
  const rawLink = await dialog.locator('.q-public-share-link code').textContent();
  expect(rawLink).toMatch(/\/share#qns_[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('A public link is active');
  await expect(page.getByRole('dialog').locator('.q-public-share-link')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('qns_');
});
