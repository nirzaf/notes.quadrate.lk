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

test('exposes create outcomes while preserving the note-only create API', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { id: 'note-1', title: 'Captured' } }, 200, { 'content-type': 'application/json', 'x-qnotes-create-outcome': 'deduplicated' });
  } });
  const detailed = await client.createNoteDetailed({ title: 'Captured', contentMarkdown: '', deviceId: 'device-1', mutationId: 'mutation-1' });
  assert.equal(detailed.note.id, 'note-1');
  assert.equal(detailed.outcome, 'deduplicated');
  const note = await client.createNote({ title: 'Captured', contentMarkdown: '', deviceId: 'device-1', mutationId: 'mutation-2' });
  assert.equal(note.id, 'note-1');
  assert.equal(calls.length, 2);
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

test('posts structured search requests and retrieves bounded document context', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => 'read-token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/context')
      ? jsonResponse({ data: { noteId: 'note-1', noteVersion: 3, documentId: 'doc-1', uri: 'qnotes://notes/note-1/documents/doc-1', title: 'Rollback', headingPath: null, content: 'exact', previous: [], next: [], updatedAt: '2026-01-01T00:00:00Z', sourceType: 'note_chunk' } })
      : jsonResponse({ data: { items: [], queryId: 'query-1', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } } });
  } });
  const controller = new AbortController();
  await client.searchPost({ query: 'rollback', mode: 'auto', limit: 5, maxPerNote: 2, filters: { tags: ['ops'] }, minimumConfidence: 0.45 }, { signal: controller.signal });
  await client.readNoteContext('doc-1', { before: 1, after: 1, maxTokens: 1800 });
  assert.equal(calls[0].url, 'http://example.test/api/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'rollback', mode: 'auto', limit: 5, maxPerNote: 2, filters: { tags: ['ops'] }, minimumConfidence: 0.45 });
  assert.equal(calls[1].url, 'http://example.test/api/search/documents/doc-1/context?before=1&after=1&maxTokens=1800');
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer read-token');
});

test('preserves search items and response metadata inside the success data envelope', async () => {
  const response = {
    items: [{ id: 'document-1', noteId: 'note-1', noteTitle: 'Deployment', snippet: 'rollback' }],
    queryId: '33333333-3333-4333-8333-333333333333',
    modeUsed: 'keyword',
    degraded: true,
    degradedReason: 'QUERY_EMBEDDING_UNAVAILABLE',
    timing: { embeddingMs: 12, retrievalMs: 4, totalMs: 16 },
  };
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async () => jsonResponse({ data: response }),
  });
  assert.deepEqual(await client.search({ query: 'rollback', mode: 'auto' }), response);
});
