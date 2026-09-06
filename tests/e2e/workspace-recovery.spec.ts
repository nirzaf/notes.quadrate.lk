import { test, expect } from './test-fixtures';
import { createClient } from '@supabase/supabase-js';
import { apiJson, createNoteApi, createPublicShareApi, getNoteApi, listAttachmentsApi, listNotesApi, localEnv, mutationIds, OTHER, signInSession } from './helpers';

function data<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  return (body as { data: T }).data;
}

async function exportWorkspace(token: string): Promise<Uint8Array> {
  const env = await localEnv();
  const response = await fetch(`${env.apiUrl}/api/export/workspace`, {
    headers: { Accept: 'application/zip', Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/zip');
  return new Uint8Array(await response.arrayBuffer());
}

async function importWorkspace(token: string, archive: Uint8Array, query: string): Promise<{ response: Response; body: unknown }> {
  const env = await localEnv();
  const response = await fetch(`${env.apiUrl}/api/import/workspace${query}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: archive as unknown as BodyInit,
  });
  const body = await response.json();
  return { response, body };
}

test('restores notebooks, tagged notes, and attachments without duplicating on retry', async () => {
  const source = await signInSession();
  const notebookName = `Recovery ${crypto.randomUUID()}`;
  const notebookResponse = await apiJson('/api/notebooks', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: notebookName }),
  });
  expect(notebookResponse.response.status).toBe(201);
  const notebook = data<{ id: string; name: string }>(notebookResponse.body);

  const title = `Round-trip ${crypto.randomUUID()}`;
  const contentMarkdown = '# Recovery round trip\n\nThe note and its private attachment must survive export and import.';
  const noteResponse = await apiJson('/api/notes', source.access_token, {
    method: 'POST',
    body: JSON.stringify({
      title,
      contentMarkdown,
      tags: ['recovery', 'round-trip'],
      notebookId: notebook.id,
      ...mutationIds(),
    }),
  });
  expect(noteResponse.response.status).toBe(201);
  const note = data<{ id: string; title: string }>(noteResponse.body);

  const bytes = new TextEncoder().encode('private recovery attachment');
  const requested = await apiJson('/api/attachments/upload-url', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ noteId: note.id, fileName: 'recovery.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength }),
  });
  expect(requested.response.status).toBe(201);
  const upload = data<{ path: string; token: string; attachment: { id: string } }>(requested.body);
  const env = await localEnv();
  const storage = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const uploaded = await storage.storage.from('note-attachments').uploadToSignedUrl(
    upload.path,
    upload.token,
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/plain' }),
  );
  if (uploaded.error) throw uploaded.error;
  const finalized = await apiJson(`/api/attachments/${upload.attachment.id}/finalize`, source.access_token, { method: 'POST' });
  expect(finalized.response.status).toBe(200);
  await createPublicShareApi(source.access_token, note.id);
  const sourceToken = await apiJson('/api/tokens', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: `Recovery token ${crypto.randomUUID()}`, scopes: ['notes:read'], expiresAt: null }),
  });
  expect(sourceToken.response.status).toBe(201);

  const archive = await exportWorkspace(source.access_token);
  const target = await signInSession(OTHER);
  expect(await listNotesApi(target.access_token)).toHaveLength(0);

  const dryRun = await importWorkspace(target.access_token, archive, '?dryRun=true');
  expect(dryRun.response.status).toBe(200);
  expect(data<{ dryRun: boolean; ready: boolean; notebooks: number; notes: number; attachments: number }>(dryRun.body)).toMatchObject({ dryRun: true, ready: true, notebooks: 1, notes: 1, attachments: 1 });
  expect(await listNotesApi(target.access_token)).toHaveLength(0);

  const restored = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(restored.response.status).toBe(200);
  expect(data<{ dryRun: boolean; notebooks: number; notes: number; attachments: number }>(restored.body)).toMatchObject({ dryRun: false, notebooks: 1, notes: 1, attachments: 1 });

  const importedNotebook = data<{ items: Array<{ id: string; name: string }> }>((await apiJson('/api/notebooks', target.access_token)).body).items.find((item) => item.name === notebookName);
  expect(importedNotebook).toBeDefined();
  const importedNote = (await listNotesApi(target.access_token)).find((item) => item.title === title);
  expect(importedNote).toMatchObject({ title, tags: ['recovery', 'round-trip'], notebookId: importedNotebook!.id });
  const importedFullNote = await getNoteApi(target.access_token, importedNote!.id);
  expect(importedFullNote.contentMarkdown).toBe(contentMarkdown);
  const importedAttachments = await listAttachmentsApi(target.access_token, importedNote!.id);
  expect(importedAttachments).toEqual([
    expect.objectContaining({ originalFileName: 'recovery.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength }),
  ]);
  const download = await apiJson(`/api/attachments/${importedAttachments[0]!.id}`, target.access_token);
  const signedUrl = data<{ signedUrl: string }>(download.body).signedUrl;
  const downloaded = await fetch(signedUrl);
  expect(downloaded.status).toBe(200);
  expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual(Array.from(bytes));
  const importedShare = await apiJson(`/api/notes/${importedNote!.id}/share`, target.access_token);
  expect(importedShare.response.status).toBe(200);
  expect((importedShare.body as { data?: unknown }).data).toBeNull();
  const importedTokens = await apiJson('/api/tokens', target.access_token);
  expect(importedTokens.response.status).toBe(200);
  expect(data<unknown[]>(importedTokens.body)).toHaveLength(0);

  const retry = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(retry.response.status).toBe(200);
  expect(data<{ dryRun: boolean; notebooks: number; notes: number; attachments: number }>(retry.body)).toMatchObject({ dryRun: false, notebooks: 1, notes: 1, attachments: 1 });
  expect((await listNotesApi(target.access_token)).filter((item) => item.title === title)).toHaveLength(1);
  expect((await listAttachmentsApi(target.access_token, importedNote!.id)).filter((item) => item.originalFileName === 'recovery.txt')).toHaveLength(1);
});

test('reports import conflicts without mutating the target workspace', async () => {
  const source = await signInSession();
  const title = `Conflict ${crypto.randomUUID()}`;
  const sourceNote = await createNoteApi(source.access_token, title, '# Source note');
  const archive = await exportWorkspace(source.access_token);

  const target = await signInSession(OTHER);
  const existing = await createNoteApi(target.access_token, title, '# Existing note');
  const before = await listNotesApi(target.access_token);
  expect(before).toHaveLength(1);

  const dryRun = await importWorkspace(target.access_token, archive, '?dryRun=true');
  expect(dryRun.response.status).toBe(200);
  const dryRunData = data<{ ready: boolean; conflicts: Array<{ kind: string; reason: string; value: string }> }>(dryRun.body);
  expect(dryRunData.ready).toBe(false);
  expect(dryRunData.conflicts).toEqual([expect.objectContaining({ kind: 'note', reason: 'slug_exists', value: sourceNote.slug })]);
  expect(await listNotesApi(target.access_token)).toEqual(before);

  const confirmed = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(confirmed.response.status).toBe(409);
  expect((confirmed.body as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');
  expect(await listNotesApi(target.access_token)).toEqual(before);
  expect((await getNoteApi(target.access_token, existing.id)).contentMarkdown).toBe('# Existing note');
});
