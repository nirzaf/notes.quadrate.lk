import { readFile } from 'node:fs/promises';
import { test, expect } from './test-fixtures';
import { createClient } from '@supabase/supabase-js';
import { apiJson, createNoteApi, invokeWorker, listAttachmentsApi, localEnv, OTHER, poll, signInSession } from './helpers';

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
  const uploaded = await storage.storage.from('note-attachments').uploadToSignedUrl(data.path, data.token, new Blob([bytes], { type: mimeType }));
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
    const rows = result.body && typeof result.body === 'object' && 'data' in result.body ? (result.body as { data?: unknown }).data : [];
    return { response: result.response, rows: Array.isArray(rows) ? rows : [] };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { attachmentId?: unknown }).attachmentId === textAttachmentId), 20_000);
  expect(textSearch.response.status).toBe(200);

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
