import { readFile } from 'node:fs/promises';
import { test, expect } from './test-fixtures';
import { createClient } from '@supabase/supabase-js';
import { apiJson, createNoteApi, getNoteApi, invokeWorker, listAttachmentsApi, localEnv, OTHER, poll, searchItems, signInPage, signInSession } from './helpers';

const marker = 'Quadrate attachment search marker 8241';

interface UploadData {
  attachment: { id: string };
  path: string;
  token: string;
}

function envelope(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') throw new Error(`Invalid API data: ${JSON.stringify(body)}`);
  return data as Record<string, unknown>;
}

async function uploadAndFinalize(token: string, noteId: string, fileName: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const requested = await apiJson('/api/attachments/upload-url', token, { method: 'POST', body: JSON.stringify({ noteId, fileName, mimeType, sizeBytes: bytes.byteLength }) });
  expect(requested.response.status).toBe(201);
  const data = envelope(requested.body) as unknown as UploadData;
  const env = await localEnv();
  const storage = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const uploaded = await storage.storage.from('note-attachments').uploadToSignedUrl(data.path, data.token, new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType }));
  if (uploaded.error) throw uploaded.error;
  const finalized = await apiJson(`/api/attachments/${data.attachment.id}/finalize`, token, { method: 'POST' });
  if (!finalized.response.ok) throw new Error(JSON.stringify(finalized.body));
  return data.attachment.id;
}

async function waitForAttachment(token: string, noteId: string, attachmentId: string, status: string): Promise<void> {
  await poll(async () => {
    await invokeWorker('attachment-worker');
    return (await listAttachmentsApi(token, noteId)).find((item) => item.id === attachmentId)?.status ?? null;
  }, (value) => value === status, 20_000);
}

test('uploads private text and PDF attachments, indexes them, and rejects image OCR claims', async () => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Attachments ${crypto.randomUUID()}`);
  const text = new Uint8Array(await readFile('tests/e2e/fixtures/sample.txt'));
  const pdf = new Uint8Array(await readFile('tests/e2e/fixtures/sample.pdf'));

  const textAttachmentId = await uploadAndFinalize(session.access_token, note.id, 'sample.txt', 'text/plain', text);
  await waitForAttachment(session.access_token, note.id, textAttachmentId, 'ready');
  const textSearch = await poll(async () => {
    const result = await apiJson('/api/search?q=8241&mode=keyword', session.access_token);
    const rows = searchItems(result.body);
    return { response: result.response, rows };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { attachmentId?: unknown }).attachmentId === textAttachmentId), 20_000);
  expect(textSearch.response.status).toBe(200);
  expect(textSearch.rows.some((row) => row && typeof row === 'object' && (row as { attachmentId?: unknown }).attachmentId === textAttachmentId)).toBe(true);

  const pdfAttachmentId = await uploadAndFinalize(session.access_token, note.id, 'sample.pdf', 'application/pdf', pdf);
  await waitForAttachment(session.access_token, note.id, pdfAttachmentId, 'ready');
  const download = await apiJson(`/api/attachments/${pdfAttachmentId}`, session.access_token);
  expect(envelope(download.body).expiresInSeconds).toBe(60);

  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const imageAttachmentId = await uploadAndFinalize(session.access_token, note.id, 'pixel.png', 'image/png', png);
  await waitForAttachment(session.access_token, note.id, imageAttachmentId, 'unsupported');
});

test('keeps attachment objects private between owners', async () => {
  const owner = await signInSession();
  const note = await createNoteApi(owner.access_token, `Private attachment ${crypto.randomUUID()}`);
  const bytes = new TextEncoder().encode(marker);
  const attachmentId = await uploadAndFinalize(owner.access_token, note.id, 'private.txt', 'text/plain', bytes);
  const other = await signInSession(OTHER);
  const result = await apiJson(`/api/attachments/${attachmentId}`, other.access_token);
  expect(result.response.status).toBe(404);
});

test('refreshes attachment processing stages in the open note without a reload', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Attachment UI ${crypto.randomUUID()}`);
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByText('Attachments', { exact: true }).click();
  await page.locator(`#attachment-upload-${note.id}`).setInputFiles('tests/e2e/fixtures/sample.txt');
  const row = page.locator('.q-attachment-row').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    await invokeWorker('attachment-worker');
    return row.textContent();
  }, { timeout: 20_000 }).toContain('Ready and searchable.');
});

test('previews a private text attachment in the open note', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Attachment preview ${crypto.randomUUID()}`);
  const bytes = new TextEncoder().encode('Private attachment preview marker 5172');
  await uploadAndFinalize(session.access_token, note.id, 'preview.txt', 'text/plain', bytes);
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByText('Attachments', { exact: true }).click();
  const row = page.locator('.q-attachment-row').first();
  await expect(row).toContainText('preview.txt');
  await row.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.q-attachment-preview-text')).toContainText('Private attachment preview marker 5172');
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
});

test('offers the screenshot modes and leaves attachments unchanged when capture is cancelled', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Screenshot cancel ${crypto.randomUUID()}`);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: async () => { throw new DOMException('User cancelled screen capture.', 'AbortError'); } },
    });
  });
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByText('Attachments', { exact: true }).click();
  await page.getByRole('button', { name: 'Screenshot' }).click();
  await expect(page.getByRole('menuitem', { name: /Visible Area/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Entire Page/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Cropped Zone/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Visible Area/ }).click();
  await expect(page.getByText('Screenshot capture cancelled.', { exact: true })).toBeVisible();
  await expect.poll(() => listAttachmentsApi(session.access_token, note.id)).toHaveLength(0);
});

test('captures the current note page through the ordinary private attachment flow', async ({ page }) => {
  const session = await signInSession();
  const markdown = Array.from({ length: 80 }, (_, index) => `## Long section ${index + 1}\n\nThis content makes the current note page meaningfully scrollable for the full-page capture.`).join('\n\n');
  const note = await createNoteApi(session.access_token, `Screenshot page ${crypto.randomUUID()}`, markdown);
  const before = await getNoteApi(session.access_token, note.id);
  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expect(page.locator('.cm-content')).toContainText('Long section 1');
  await page.getByText('Attachments', { exact: true }).click();
  await page.getByRole('button', { name: 'Screenshot' }).click();
  await page.getByRole('menuitem', { name: /Entire Page/ }).click();
  await expect(page.getByText('Screenshot attached securely.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await listAttachmentsApi(session.access_token, note.id)).filter((item) => item.mimeType === 'image/png' && /^screenshot-page-.*\.png$/.test(item.originalFileName))).not.toHaveLength(0);
  await expect.poll(() => getNoteApi(session.access_token, note.id)).toMatchObject({ contentMarkdown: before.contentMarkdown, title: before.title, tags: before.tags, version: before.version });
  await expect(page.locator('.cm-content')).toBeVisible();
});
