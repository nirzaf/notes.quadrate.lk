import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, createPublicShareApi, expectPreviewMode, getNoteApi, OTHER, OWNER, publicApiJson, resolvePublicShareApi, signInPage, signInSession } from './helpers';

function data(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || !('data' in body) || !body.data || typeof body.data !== 'object') throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  return body.data as Record<string, unknown>;
}

test('renders a saved note publicly through the fragment without private API requests', async ({ browser }) => {
  const session = await signInSession();
  const publicMarkdown = [
    '# Public heading',
    '',
    '## Public subheading',
    '',
    '### Public detail',
    '',
    'Long value: https://example.test/public-share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '',
    '| Field | Value | Description | Link | Status | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
    '| safe | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | A deliberately long synthetic value that must wrap inside its cell. | https://example.test/public-share/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | public | Six columns keep this table genuinely wide on narrow viewports. |',
    '',
    '```text',
    'const safeValue = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
    '```',
  ].join('\n');
  const note = await createNoteApi(session.access_token, `Public view ${crypto.randomUUID()}`, publicMarkdown);
  const share = await createPublicShareApi(session.access_token, note.id);
  const context = await browser.newContext();
  const page = await context.newPage();
  const functionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/functions/v1/qnotes-api/')) functionRequests.push(request.url());
  });

  const resolved = await resolvePublicShareApi(share.token);
  expect(resolved.response.status).toBe(200);
  expect(data(resolved.body)).toEqual({ title: note.title, contentMarkdown: publicMarkdown, updatedAt: expect.any(String) });
  expect(data(resolved.body)).not.toHaveProperty('attachments');
  expect(resolved.response.headers.get('cache-control')).toBe('no-store');

  const getResolver = await publicApiJson('/public/share/resolve?token=qns_test');
  expect([404, 405]).toContain(getResolver.response.status);
  expect(JSON.stringify(getResolver.body)).not.toContain('safeValue');

  await page.goto(`/share#${share.token}`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();
  await expect(page.locator('.q-public-share-note .q-preview h3')).toBeVisible();
  const titleFontSize = await page.locator('.q-public-share-note > header h1').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const bodyHeadingSizes = await page.locator('.q-public-share-note .q-preview').evaluate((preview) => {
    const getHeadingSize = (selector: 'h1' | 'h2' | 'h3'): number => {
      const heading = preview.querySelector(selector);
      if (!heading) throw new Error(`Missing Markdown ${selector} heading.`);
      return Number.parseFloat(getComputedStyle(heading).fontSize);
    };
    return {
      h1: getHeadingSize('h1'),
      h2: getHeadingSize('h2'),
      h3: getHeadingSize('h3'),
    };
  });
  expect(titleFontSize).toBeLessThanOrEqual(48);
  expect(bodyHeadingSizes.h1).toBeLessThan(titleFontSize);
  expect(bodyHeadingSizes.h1).toBeGreaterThan(bodyHeadingSizes.h2);
  expect(bodyHeadingSizes.h2).toBeGreaterThan(bodyHeadingSizes.h3);
  await expect(page.locator('.q-public-share-note')).toContainText('Long value:');
  await expect(page.locator('.q-public-share-note .q-preview table')).toBeVisible();
  await expect(page.locator('.q-public-share-note .q-preview table th')).toHaveCount(6);
  await expect(page.locator('.q-public-share-note .q-preview pre')).toBeVisible();
  await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(publicMarkdown);
  await expect(page.getByRole('button', { name: 'Markdown copied' })).toContainText('Copied');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await page.evaluate(() => {
      const preview = document.querySelector<HTMLElement>('.q-public-share-note .q-preview');
      const localContent = [...document.querySelectorAll<HTMLElement>('.q-public-share-note .q-preview pre, .q-public-share-note .q-preview table')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowX: getComputedStyle(element).overflowX };
      });
      return {
        viewport: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        previewScrollWidth: preview?.scrollWidth ?? 0,
        previewClientWidth: preview?.clientWidth ?? 0,
        copyButton: (() => {
          const element = document.querySelector<HTMLElement>('.q-public-share-copy');
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        })(),
        localContent,
      };
    });
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.previewScrollWidth).toBeLessThanOrEqual(metrics.previewClientWidth);
    expect(metrics.copyButton).not.toBeNull();
    expect(metrics.copyButton?.width).toBeGreaterThan(0);
    expect(metrics.copyButton?.left).toBeGreaterThanOrEqual(0);
    expect(metrics.copyButton?.right).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.localContent.every((element) => element.left >= 0 && element.right <= metrics.viewport)).toBe(true);
    expect(metrics.localContent.every((element) => element.scrollWidth <= element.clientWidth || element.overflowX === 'auto' || element.overflowX === 'scroll')).toBe(true);
  }
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error('The async clipboard API is unavailable for the fallback test.');
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('Forced fallback path.')) });
  });
  await page.locator('.q-public-share-copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(publicMarkdown);
  await expect(page.getByRole('button', { name: 'Markdown copied' })).toContainText('Copied');
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
  const getResolver = await publicApiJson('/public/share/resolve?token=qns_test');
  expect([404, 405]).toContain(getResolver.response.status);
  const revoked = await apiJson(`/api/notes/${note.id}/share`, session.access_token, { method: 'DELETE' });
  expect(revoked.response.status).toBe(200);
  expect((await resolvePublicShareApi(second.token)).response.status).toBe(404);
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

test('shares:write tokens manage only their owner shares and older qnt tokens remain denied', async () => {
  const session = await signInSession(OWNER);
  const note = await createNoteApi(session.access_token, `Share token boundary ${crypto.randomUUID()}`, 'Boundary body.');
  const otherSession = await signInSession(OTHER);
  const otherNote = await createNoteApi(otherSession.access_token, `Other owner share boundary ${crypto.randomUUID()}`, 'Other owner body.');

  const oldTokenResponse = await apiJson('/api/tokens', session.access_token, { method: 'POST', body: JSON.stringify({ name: `share-boundary-old-${crypto.randomUUID()}`, scopes: ['notes:read'], expiresAt: null }) });
  const oldToken = String(data(oldTokenResponse.body).token);
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    const denied = await apiJson(`/api/notes/${note.id}/share`, oldToken, { method, ...(method === 'POST' ? { body: JSON.stringify({ expiresAt: null }) } : {}) });
    expect(denied.response.status).toBe(403);
  }

  const shareTokenResponse = await apiJson('/api/tokens', session.access_token, { method: 'POST', body: JSON.stringify({ name: `share-boundary-${crypto.randomUUID()}`, scopes: ['shares:write'], expiresAt: null }) });
  const shareToken = String(data(shareTokenResponse.body).token);
  const created = await apiJson(`/api/notes/${note.id}/share`, shareToken, { method: 'POST', body: JSON.stringify({ expiresAt: null }) });
  expect(created.response.status).toBe(201);
  const share = data(created.body);
  expect((await apiJson(`/api/notes/${note.id}/share`, shareToken)).response.status).toBe(200);
  expect((await apiJson(`/api/notes/${otherNote.id}/share`, shareToken)).response.status).toBe(404);
  expect((await apiJson(`/api/notes/${note.id}/share`, shareToken, { method: 'DELETE' })).response.status).toBe(200);
  expect((await resolvePublicShareApi(String(share.token))).response.status).toBe(404);
  expect((await resolvePublicShareApi(shareToken)).response.status).toBe(404);
});

test('share dialog shows the raw link once and safe metadata after reopening', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Share dialog ${crypto.randomUUID()}`, 'Dialog body.');
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
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
