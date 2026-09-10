import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  const client = new QNotesClient({ baseUrl: 'https://example.test///', getAccessToken: () => 'jwt', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { items: [], nextCursor: null } });
  } });
  await client.listNotes({ limit: 10, includeDeleted: false, tag: 'ops' });
  assert.equal(calls[0].url, 'https://example.test/api/notes?limit=10&includeDeleted=false&tag=ops');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer jwt');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('requires HTTPS or explicitly enabled exact loopback HTTP endpoints', async () => {
  for (const baseUrl of [
    'http://example.test',
    'http://127.0.0.1.attacker.test',
    'https://example.test?token=secret',
    'https://example.test?',
    'https://example.test#',
    'https://user:password@example.test',
    'https://example.test/#fragment',
    'https://example.test/functions/../qnotes-api',
    'https://example.test/functions/%2e%2e/qnotes-api',
    'https://example.test/functions/%2f../qnotes-api',
  ]) {
    assert.throws(() => new QNotesClient({ baseUrl, getAccessToken: () => null }), /API endpoint/);
  }
  assert.doesNotThrow(() => new QNotesClient({ baseUrl: 'http://127.0.0.1:54321/functions/v1/qnotes-api', allowInsecureLoopback: true, getAccessToken: () => null }));
});

test('sanitizes access-token and transport failures', async () => {
  const secret = 'qnt_synthetic_transport_secret';
  const tokenFailure = new QNotesClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => { throw new Error(`provider leaked ${secret}`); },
    fetchImplementation: async () => jsonResponse({ data: { items: [], nextCursor: null } }),
  });
  await assert.rejects(() => tokenFailure.listNotes(), (error) => error.message === 'QNotes request failed.' && !error.message.includes(secret));

  const fetchFailure = new QNotesClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => secret,
    fetchImplementation: async () => { throw new Error(`network leaked ${secret}`); },
  });
  await assert.rejects(() => fetchFailure.listNotes(), (error) => error.message === 'QNotes request failed.' && !error.message.includes(secret));
});

test('redacts overlapping request secrets and request-id fallbacks', async () => {
  const secret = 'abcdef';
  const client = new QNotesClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => 'abc',
    fetchImplementation: async () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: secret, details: { value: secret } } }, 500, {
      'content-type': 'application/json',
      'x-request-id': secret,
    }),
  });
  await assert.rejects(() => client.createNote({ title: 'x', contentMarkdown: '', value: secret, deviceId: 'd', mutationId: 'm' }), (error) => {
    assert.equal(error.message, '[REDACTED]');
    assert.equal(error.requestId, '[REDACTED]');
    assert.deepEqual(error.details, { value: '[REDACTED]' });
    return true;
  });
});

test('rejects credential-bearing redirects before the destination receives the body', async (t) => {
  let sinkRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/notes') {
      response.writeHead(307, { Location: '/sink' });
      response.end();
      return;
    }
    sinkRequests += 1;
    request.resume();
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new QNotesClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowInsecureLoopback: true,
    getAccessToken: () => 'qnt_synthetic_redirect_secret',
  });
  await assert.rejects(() => client.createNote({ title: 'redirect', contentMarkdown: 'secret', deviceId: 'device-1', mutationId: 'mutation-1' }), /QNotes request failed/);
  assert.equal(sinkRequests, 0);
});

test('keeps export cancellation active until the response body is consumed', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('partial');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new QNotesClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowInsecureLoopback: true,
    getAccessToken: () => null,
  });
  const controller = new AbortController();
  const response = await client.exportWorkspace({ signal: controller.signal });
  controller.abort();
  await assert.rejects(() => response.arrayBuffer(), (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError');
});

test('serializes notebook, unfiled, deleted-only, and include-deleted list filters', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return url.includes('/notes/note-1') ? jsonResponse({ data: notePayload() }) : jsonResponse({ data: { items: [], nextCursor: null } });
  } });
  await client.listNotes({ limit: 25, notebookId: 'notebook-1', unfiled: false, deletedOnly: true, includeDeleted: true, tag: 'ops' });
  await client.getNote('note-1', { includeDeleted: true });
  assert.equal(calls[0].url, 'https://example.test/api/notes?limit=25&includeDeleted=true&deletedOnly=true&notebookId=notebook-1&unfiled=false&tag=ops');
  assert.equal(calls[1].url, 'https://example.test/api/notes/note-1?includeDeleted=true');
});

test('parses error envelopes and keeps mutation requests single-shot', async () => {
  let calls = 0;
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async () => {
    calls += 1;
    return jsonResponse({ error: { code: 'NOTE_VERSION_CONFLICT', message: 'stale', requestId: 'request-1', details: { currentVersion: 2 } } }, 409);
  } });
  await assert.rejects(() => client.createNote({ title: 'x', contentMarkdown: '', tags: [], deviceId: 'd', mutationId: 'm' }), (error) => error instanceof QNotesHttpError && error.status === 409 && error.code === 'NOTE_VERSION_CONFLICT');
  assert.equal(calls, 1);
});

test('exposes create outcomes while preserving the note-only create API', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
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
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => 'token', fetchImplementation: async () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': 'application/zip' } }) });
  const response = await client.exportWorkspace();
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4]);
});

test('supports dry-run and explicit workspace import requests', async () => {
  const calls = [];
  const summary = {
    dryRun: true, ready: true, message: 'valid', format: 'quadrate-notes-workspace', formatVersion: 2,
    backupId: '550e8400-e29b-41d4-a716-446655440000', compressedBytes: 10, declaredUncompressedBytes: 20,
    entries: 2, uncompressedBytes: 20, noteMarkdownBytes: 8, attachmentBytes: 0, conflicts: [],
    unsupportedFiles: [], validationFailures: [], notebooks: 0, notes: 1, attachments: 0,
  };
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => 'token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { ...summary, dryRun: url.endsWith('/import/workspace'), ready: true } });
  } });
  const archive = new Uint8Array([80, 75]);
  await client.importWorkspace(archive);
  await client.importWorkspace(archive, { confirm: true });
  assert.equal(calls[0].url, 'https://example.test/api/import/workspace');
  assert.equal(calls[1].url, 'https://example.test/api/import/workspace?confirm=true');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.get('Content-Type'), 'application/zip');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer token');
  assert.deepEqual([...new Uint8Array(await new Response(calls[0].init.body).arrayBuffer())], [80, 75]);
});

test('supports notebook listing, creation, and versioned note moves', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async (url, init) => {
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
  assert.equal(calls[0].url, 'https://example.test/api/notebooks');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[2].url, 'https://example.test/api/notes/note-1/notebook');
  assert.deepEqual(JSON.parse(calls[2].init.body), { notebookId: 'n-1', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
});

test('keeps caller-owned share management authenticated and validates safe metadata', async () => {
  const calls = [];
  const metadata = { id: 'share-1', noteId: 'note-1', tokenPrefix: 'qns_Abcd1234', expiresAt: null, revokedAt: null, createdAt: '2026-01-01T00:00:00Z' };
  const client = new QNotesClient({ getAccessToken: () => 'qnt_synthetic-share-token', baseUrl: 'https://example.test', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'POST') return jsonResponse({ data: { token: 'qns_A'.padEnd(47, 'a'), metadata } }, 201);
    if (init?.method === 'DELETE') return jsonResponse({ data: null });
    return jsonResponse({ data: metadata });
  } });
  assert.deepEqual(await client.getPublicShare('note-1'), metadata);
  assert.deepEqual(await client.createPublicShare('note-1', { expiresAt: null }), { token: 'qns_A'.padEnd(47, 'a'), metadata });
  await client.revokePublicShare('note-1');
  assert.equal(calls[0].url, 'https://example.test/api/notes/note-1/share');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer qnt_synthetic-share-token');
  assert.deepEqual(JSON.parse(calls[1].init.body), { expiresAt: null });
  assert.equal(calls[2].init.method, 'DELETE');
});

test('resolves public shares without requesting or sending a private JWT', async () => {
  let tokenProviderCalls = 0;
  let request;
  const token = 'qns_' + 'A'.repeat(43);
  const note = { title: 'Shared', contentMarkdown: '# Shared', updatedAt: '2026-01-01T00:00:00Z' };
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => { tokenProviderCalls += 1; throw new Error('private token must not be requested'); }, fetchImplementation: async (url, init) => {
    request = { url, init };
    return jsonResponse({ data: note });
  } });
  assert.deepEqual(await client.resolvePublicShare(token), note);
  assert.equal(tokenProviderCalls, 0);
  assert.equal(request.url, 'https://example.test/public/share/resolve');
  assert.equal(request.init.headers.get('Authorization'), null);
  assert.deepEqual(JSON.parse(request.init.body), { token });
});

test('rejects a malformed public shared note payload', async () => {
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async () => jsonResponse({ data: { title: 'Shared', contentMarkdown: '' } }) });
  await assert.rejects(() => client.resolvePublicShare('qns_' + 'A'.repeat(43)), /malformed public shared note/);
});

test('posts logical append requests without rewriting the note client-side', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => 'write-token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: notePayload({ version: 2, contentMarkdown: '# Existing\n\nAdded\n', contentPlain: 'Existing Added', updatedAt: '2026-01-01T00:00:01Z' }) });
  } });
  await client.appendNote('note-1', { contentMarkdown: 'Added', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
  assert.equal(calls[0].url, 'https://example.test/api/notes/note-1/append');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { contentMarkdown: 'Added', expectedVersion: 1, deviceId: 'device-1', mutationId: 'mutation-1' });
});

test('posts structured search requests and retrieves bounded document context', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => 'read-token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return url.includes('/context?')
      ? jsonResponse({ data: { noteId: 'note-1', noteVersion: 3, documentId: 'doc-1', uri: 'qnotes://notes/note-1/documents/doc-1', title: 'Rollback', headingPath: null, content: 'exact', previous: [], next: [], updatedAt: '2026-01-01T00:00:00Z', sourceType: 'note_chunk' } })
      : jsonResponse({ data: { items: [], queryId: 'query-1', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } } });
  } });
  const controller = new AbortController();
  await client.searchPost({ query: 'rollback', mode: 'auto', limit: 5, maxPerNote: 2, filters: { tags: ['ops'] }, minimumConfidence: 0.45 }, { signal: controller.signal });
  await client.readNoteContext('doc-1', { before: 1, after: 1, maxTokens: 1800 });
  assert.equal(calls[0].url, 'https://example.test/api/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.notEqual(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'rollback', mode: 'auto', limit: 5, maxPerNote: 2, filters: { tags: ['ops'] }, minimumConfidence: 0.45 });
  assert.equal(calls[1].url, 'https://example.test/api/search/documents/doc-1/context?before=1&after=1&maxTokens=1800');
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
    tokenBudget: { max: 4, used: 4, unit: 'approximate_tokens' }, continuation: { cursor: 'opaque-context-cursor', noteVersion: 3, sourceHash: 'center-hash', nextOffset: 4 }, previousSources: [source], nextSources: [],
  };
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async () => jsonResponse({ data: context }) });
  assert.deepEqual(await client.readNoteContext('doc-1'), context);

  const malformedClient = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => null, fetchImplementation: async () => jsonResponse({ data: { ...context, previousSources: [{ ...source, truncated: 'false' }] } }) });
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
    baseUrl: 'https://example.test',
    getAccessToken: () => null,
    fetchImplementation: async () => jsonResponse({ data: response }),
  });
  assert.deepEqual(await client.search({ query: 'rollback', mode: 'auto' }), response);
});

test('rejects a malformed notes success payload instead of treating it as an empty result', async () => {
  const client = new QNotesClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => null,
    fetchImplementation: async () => jsonResponse({ data: { items: { not: 'an array' }, nextCursor: null } }),
  });
  await assert.rejects(() => client.listNotes(), /malformed notes list/);
});

test('passes cancellation signals through list and detail reads', async () => {
  const calls = [];
  const client = new QNotesClient({
    baseUrl: 'https://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (url, init) => {
      calls.push(init.signal);
      return url.includes('/notes/note-1') ? jsonResponse({ data: notePayload() }) : jsonResponse({ data: { items: [], nextCursor: null } });
    },
  });
  const controller = new AbortController();
  await client.listNotes({ signal: controller.signal });
  await client.getNote('note-1', { signal: controller.signal });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], controller.signal);
  assert.notEqual(calls[1], controller.signal);
});

test('composes timeout signals while preserving the caller abort reason', async () => {
  let requestSignal;
  const client = new QNotesClient({
    baseUrl: 'https://example.test',
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
    baseUrl: 'https://example.test',
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
    baseUrl: 'https://example.test',
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
    baseUrl: 'https://example.test',
    getAccessToken: () => null,
    fetchImplementation: async (_url, init) => {
      calls += 1;
      return waitForAbort(init.signal);
    },
  });
  await assert.rejects(client.createNote({ title: 'x', contentMarkdown: '', tags: [], deviceId: 'd', mutationId: 'm' }, { timeoutMs: 10 }), (error) => error?.name === 'TimeoutError');
  assert.equal(calls, 1);
});
