import test from 'node:test';
import assert from 'node:assert/strict';
import { QNotesClient, QNotesHttpError } from '../dist/index.js';

function jsonResponse(body, status = 200, headers = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify(body), { status, headers });
}

test('normalizes base URL, serializes queries, and sends authorization', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test///', getAccessToken: () => 'jwt', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { items: [], nextCursor: null } });
  } });
  await client.listNotes({ limit: 10, includeDeleted: false, tag: 'ops' });
  assert.equal(calls[0].url, 'http://example.test/api/notes?limit=10&includeDeleted=false&tag=ops');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer jwt');
});

test('parses error envelopes and keeps mutation requests single-shot', async () => {
  let calls = 0;
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async () => {
    calls += 1;
    return jsonResponse({ error: { code: 'NOTE_VERSION_CONFLICT', message: 'stale', requestId: 'request-1', details: { currentVersion: 2 } } }, 409);
  } });
  await assert.rejects(() => client.createNote({ title: 'x', contentMarkdown: '', tags: [], deviceId: 'd', mutationId: 'm' }), (error) => error instanceof QNotesHttpError && error.status === 409 && error.code === 'NOTE_VERSION_CONFLICT');
  assert.equal(calls, 1);
});

test('returns successful binary exports without JSON conversion', async () => {
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => 'token', fetchImplementation: async () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': 'application/zip' } }) });
  const response = await client.exportWorkspace();
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4]);
});

test('supports notebook listing, creation, and versioned note moves', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/notebooks') && init?.method === 'POST'
      ? { data: { id: 'n-1', name: 'Work', createdAt: '2026-01-01', updatedAt: '2026-01-01' } }
      : url.includes('/notebook')
        ? { data: { id: 'note-1', notebookId: 'n-1' } }
        : { data: { items: [] } };
    return jsonResponse(body);
  } });
  await client.listNotebooks();
  await client.createNotebook({ name: 'Work' });
  await client.moveNoteToNotebook('note-1', { notebookId: 'n-1', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
  assert.equal(calls[0].url, 'http://example.test/api/notebooks');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[2].url, 'http://example.test/api/notes/note-1/notebook');
  assert.deepEqual(JSON.parse(calls[2].init.body), { notebookId: 'n-1', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
});
