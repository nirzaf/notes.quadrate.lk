import test from 'node:test';
import assert from 'node:assert/strict';
import { QNotesClient, QNotesHttpError } from '../dist/index.js';

function jsonResponse(body, status = 200, headers = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify(body), { status, headers });
}

function notePayload(overrides = {}) {
  return {
    id: 'note-1', slug: 'note', title: 'A note', contentMarkdown: '', contentPlain: '', tags: [], notebookId: null,
    version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null, ...overrides,
  };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
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

test('serializes notebook, unfiled, deleted-only, and include-deleted list filters', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return url.includes('/notes/note-1') ? jsonResponse({ data: notePayload() }) : jsonResponse({ data: { items: [], nextCursor: null } });
  } });
  await client.listNotes({ limit: 25, notebookId: 'notebook-1', unfiled: false, deletedOnly: true, includeDeleted: true, tag: 'ops' });
  await client.getNote('note-1', { includeDeleted: true });
  assert.equal(calls[0].url, 'http://example.test/api/notes?limit=25&includeDeleted=true&deletedOnly=true&notebookId=notebook-1&unfiled=false&tag=ops');
  assert.equal(calls[1].url, 'http://example.test/api/notes/note-1?includeDeleted=true');
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
    return jsonResponse({ data: notePayload({ title: 'Captured' }) }, 200, { 'content-type': 'application/json', 'x-qnotes-create-outcome': 'deduplicated' });
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
      : url.includes('/notebook') && !url.endsWith('/notebooks')
        ? { data: notePayload({ notebookId: 'n-1' }) }
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

test('posts logical append requests without rewriting the note client-side', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => 'write-token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: notePayload({ version: 2, contentMarkdown: '# Existing\n\nAdded\n', contentPlain: 'Existing Added', updatedAt: '2026-01-01T00:00:01Z' }) });
  } });
  await client.appendNote('note-1', { contentMarkdown: 'Added', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
  assert.equal(calls[0].url, 'http://example.test/api/notes/note-1/append');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { contentMarkdown: 'Added', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
});

test('posts structured search requests and retrieves bounded document context', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => 'read-token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return url.includes('/context?')
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

test('accepts old context payloads and validates additive provenance fields', async () => {
  const source = {
    documentId: 'neighbor-1', noteId: 'note-1', noteVersion: 3, sourceType: 'note_chunk', sourceId: null,
    sourceKey: 'section-1', sourceTitle: 'Rollback', headingPath: 'Production', attachmentId: null,
    pageNumber: null, content: 'neighbor', sourceHash: 'neighbor-hash', truncated: false,
  };
  const context = {
    noteId: 'note-1', noteVersion: 3, documentId: 'doc-1', uri: 'qnotes://notes/note-1/documents/doc-1',
    title: 'Rollback', headingPath: null, content: 'exact', previous: ['neighbor'], next: [],
    updatedAt: '2026-01-01T00:00:00Z', sourceType: 'note_chunk', sourceHash: 'center-hash', truncated: true,
    tokenBudget: { max: 4, used: 4, unit: 'approximate_tokens' }, previousSources: [source], nextSources: [],
  };
  const client = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async () => jsonResponse({ data: context }) });
  assert.deepEqual(await client.readNoteContext('doc-1'), context);

  const malformedClient = new QNotesClient({ baseUrl: 'http://example.test', getAccessToken: () => null, fetchImplementation: async () => jsonResponse({ data: { ...context, previousSources: [{ ...source, truncated: 'false' }] } }) });
  await assert.rejects(() => malformedClient.readNoteContext('doc-1'), /malformed search context/);
});

test('preserves search items and response metadata inside the success data envelope', async () => {
  const response = {
    items: [{ id: 'document-1', documentId: 'document-1', noteId: 'note-1', noteVersion: 1, noteSlug: 'deployment', noteTitle: 'Deployment', sourceType: 'note_chunk', sourceId: null, sourceKey: 'section-1', sourceTitle: 'Deployment', headingPath: null, snippet: 'rollback', score: 1, keywordRank: 1, semanticRank: null, copyable: false, blockKey: null, language: null, attachmentId: null }],
    queryId: '33333333-3333-4333-8333-333333333333',
    modeUsed: 'keyword',
    degraded: true,
    degradedReason: 'QUERY_EMBEDDING_UNAVAILABLE',
    timing: { embeddingMs: 12, retrievalMs: 4, metadataMs: 2, freshnessMs: 1, serializationMs: 0, totalMs: 16 },
    index: { model: 'gte-small:v2', pendingDocuments: 2, failedDocuments: 0, oldestPendingAgeSeconds: 4, fresh: false, freshness: 'unknown' },
  };
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async () => jsonResponse({ data: response }),
  });
  assert.deepEqual(await client.search({ query: 'rollback', mode: 'auto' }), response);
});

test('rejects a malformed notes success payload instead of treating it as an empty result', async () => {
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async () => jsonResponse({ data: { items: { not: 'an array' }, nextCursor: null } }),
  });
  await assert.rejects(() => client.listNotes(), /malformed notes list/);
});

test('passes cancellation signals through list and detail reads', async () => {
  const calls = [];
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (url, init) => {
      calls.push(init.signal);
      return url.includes('/notes/note-1') ? jsonResponse({ data: notePayload() }) : jsonResponse({ data: { items: [], nextCursor: null } });
    },
  });
  const controller = new AbortController();
  await client.listNotes({ signal: controller.signal });
  await client.getNote('note-1', { signal: controller.signal });
  assert.deepEqual(calls, [controller.signal, controller.signal]);
});

test('composes timeout signals while preserving the caller abort reason', async () => {
  let requestSignal;
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      requestSignal = init.signal;
      return waitForAbort(init.signal);
    },
  });
  const caller = new AbortController();
  const reason = new Error('component disposed');
  const request = client.search({ query: 'rollback', signal: caller.signal, timeoutMs: 1000 });
  while (!requestSignal) await new Promise((resolve) => setImmediate(resolve));
  caller.abort(reason);
  await assert.rejects(request, (error) => error === reason);
  assert.notEqual(requestSignal, caller.signal);
  assert.equal(requestSignal.reason, reason);
});

test('aborts a pending request at its bounded per-call timeout', async () => {
  let requestSignal;
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      requestSignal = init.signal;
      return waitForAbort(init.signal);
    },
  });
  await assert.rejects(client.search({ query: 'rollback', timeoutMs: 10 }), (error) => error?.name === 'TimeoutError');
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.name, 'TimeoutError');
});

test('cleans up a request timeout after a successful response', async () => {
  let requestSignal;
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      requestSignal = init.signal;
      return jsonResponse({ data: { items: [], nextCursor: null } });
    },
  });
  await client.listNotes({ timeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requestSignal.aborted, false);
});

test('does not retry a mutation after its request is aborted', async () => {
  let calls = 0;
  const client = new QNotesClient({
    baseUrl: 'http://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      calls += 1;
      return waitForAbort(init.signal);
    },
  });
  await assert.rejects(client.createNote({ title: 'x', contentMarkdown: '', tags: [], deviceId: 'd', mutationId: 'm' }, { timeoutMs: 10 }), (error) => error?.name === 'TimeoutError');
  assert.equal(calls, 1);
});
