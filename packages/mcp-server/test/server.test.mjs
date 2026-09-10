import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getBlockTool } from '../dist/tools/get-block.js';
import { readNoteContextTool } from '../dist/tools/read-note-context.js';
import { createPublicShareTool } from '../dist/tools/create-public-share.js';
import { searchNotesTool } from '../dist/tools/search-notes.js';
import { appendNoteTool, captureNoteTool, deleteNoteTool, restoreNoteTool, updateNoteTool } from '../dist/tools/write-notes.js';
import { appendMarkdown, MAX_MCP_TOOL_RESPONSE_BYTES, toolResult } from '../dist/tools/common.js';
import { PROFILE_TOOL_NAMES, READ_TOOL_NAMES, SHARE_PROFILE_TOOL_NAMES, SHARE_TOOL_NAMES, WRITE_PROFILE_TOOL_NAMES, WRITE_TOOL_NAMES, createQNotesMcpServer } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const context = {
  noteId: 'note-1', noteVersion: 4, documentId: 'doc-1', uri: 'qnotes://notes/note-1/documents/doc-1',
  title: 'Rollback', headingPath: 'Production > Rollback', content: 'exact', previous: [], next: [],
  updatedAt: '2026-01-01T00:00:00Z', sourceType: 'note_chunk',
};

function mockClient() {
  return {
    async searchPost(input) {
      assert.deepEqual(input, { query: 'rollback', mode: 'auto', limit: 8, maxPerNote: 2, filters: {} });
      return { items: [], queryId: 'query-1', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
    },
    async readNoteContext(documentId, params) {
      assert.equal(documentId, 'doc-1');
      assert.deepEqual(params, { before: 1, after: 2, maxTokens: 900, maxBytes: 15 * 1024 });
      return context;
    },
    async getBlock(noteRef, blockKey, options) {
      assert.equal(noteRef, 'note-1');
      assert.equal(blockKey, 'rollback');
      assert.deepEqual(options, { maxBytes: 15 * 1024 });
      return { id: 'block-1', noteId: 'note-1', blockKey, blockType: 'command', title: 'Rollback', language: 'bash', content: 'docker compose down', position: 0, copyable: true, contentHash: 'hash' };
    },
  };
}

test('read MCP tools delegate to the API client and return structured JSON', async () => {
  const client = mockClient();
  const search = await searchNotesTool(client, { query: 'rollback' });
  const read = await readNoteContextTool(client, { documentId: 'doc-1', before: 1, after: 2, maxTokens: 900 });
  const block = await getBlockTool(client, { noteRef: 'note-1', blockKey: 'rollback' });
  assert.deepEqual(JSON.parse(search.content[0].text), { items: [], queryId: 'query-1', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } });
  assert.deepEqual(JSON.parse(read.content[0].text), context);
  assert.equal(JSON.parse(block.content[0].text).blockKey, 'rollback');
});

test('MCP read results enforce the complete duplicated wire envelope limit', async () => {
  assert.equal(MAX_MCP_TOOL_RESPONSE_BYTES, 64 * 1024);
  await assert.rejects(() => getBlockTool({
    async getBlock() {
      return { id: 'block-1', noteId: 'note-1', blockKey: 'large', blockType: 'code', title: null, language: 'text', content: 'x'.repeat(40_000), position: 0, copyable: true, contentHash: 'hash' };
    },
  }, { noteRef: 'note-1', blockKey: 'large' }), /wire-byte limit/);
});

test('MCP read context forwards an opaque continuation only when supplied', async () => {
  let received;
  await readNoteContextTool({
    async readNoteContext(documentId, params) {
      received = { documentId, params };
      return context;
    },
  }, { documentId: 'doc-1', continuation: 'opaque-context-cursor' });
  assert.deepEqual(received, { documentId: 'doc-1', params: { before: 1, after: 1, maxTokens: 1800, maxBytes: 15 * 1024, continuation: 'opaque-context-cursor' } });
});

test('default MCP profile exposes only the read surface', () => {
  const server = createQNotesMcpServer(mockClient());
  assert.ok(server);
  assert.deepEqual(READ_TOOL_NAMES, ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share']);
  assert.deepEqual(SHARE_TOOL_NAMES, ['create_public_share']);
});

test('MCP create_public_share uses an exact one-day expiry and constructs the public URL', async () => {
  const noteId = '550e8400-e29b-41d4-a716-446655440000';
  const token = `qns_${'A'.repeat(43)}`;
  let received;
  const result = await createPublicShareTool({
    async getNote(receivedNoteId) {
      assert.equal(receivedNoteId, noteId);
      return { title: 'Release notes', contentMarkdown: '# Safe', id: noteId, version: 1 };
    },
    async createPublicShare(receivedNoteId, input) {
      received = { noteId: receivedNoteId, input };
      return { token, metadata: {} };
    },
  }, { noteId, expectedVersion: 1, confirm: true }, { now: () => new Date('2026-09-07T12:34:56.789Z') });

  assert.deepEqual(received, {
    noteId,
    input: { expectedVersion: 1, expiresAt: '2026-09-08T12:34:56.789Z', confirm: true },
  });
  assert.deepEqual(result.structuredContent, {
    url: `https://notes.quadrate.lk/share#${token}`,
    noteId,
    expiresAt: '2026-09-08T12:34:56.789Z',
  });
});

test('MCP create_public_share keeps the legacy input parseable but fails closed', async () => {
  let calls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      calls += 1;
      throw new Error('must not be called');
    },
    async createPublicShare() {
      calls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: '550e8400-e29b-41d4-a716-446655440000' }), /requires expectedVersion and confirm=true/);
  assert.equal(calls, 0);
});

test('MCP create_public_share rejects sensitive notes before calling the share API', async () => {
  let shareCalls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      return { title: 'Deployment', contentMarkdown: 'service_password: synthetic-secret-value', id: '550e8400-e29b-41d4-a716-446655440000', version: 1 };
    },
    async createPublicShare() {
      shareCalls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: '550e8400-e29b-41d4-a716-446655440000', expectedVersion: 1, confirm: true }), /sensitive credential material/);
  assert.equal(shareCalls, 0);
});

test('MCP create_public_share rejects snake_case credential assignments before calling the share API', async () => {
  let shareCalls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      return { title: 'Deployment', contentMarkdown: 'OPENAI_API_KEY=synthetic-secret-value', id: '550e8400-e29b-41d4-a716-446655440000', version: 1 };
    },
    async createPublicShare() {
      shareCalls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: '550e8400-e29b-41d4-a716-446655440000', expectedVersion: 1, confirm: true }), /sensitive credential material/);
  assert.equal(shareCalls, 0);
});

test('MCP create_public_share rejects qvt credentials in note Markdown before calling the share API', async () => {
  const qvtToken = `qvt_${'A'.repeat(43)}`;
  let shareCalls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      return { title: 'Deployment', contentMarkdown: `Use this credential: ${qvtToken}`, id: '550e8400-e29b-41d4-a716-446655440000', version: 1 };
    },
    async createPublicShare() {
      shareCalls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: '550e8400-e29b-41d4-a716-446655440000', expectedVersion: 1, confirm: true }), /sensitive credential material/);
  assert.equal(shareCalls, 0);
});

test('MCP create_public_share rejects qvt credentials in the note title before calling the share API', async () => {
  const qvtToken = `qvt_${'B'.repeat(43)}`;
  let shareCalls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      return { title: `Vault token ${qvtToken}`, contentMarkdown: '# Safe', id: '550e8400-e29b-41d4-a716-446655440000', version: 1 };
    },
    async createPublicShare() {
      shareCalls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: '550e8400-e29b-41d4-a716-446655440000', expectedVersion: 1, confirm: true }), /sensitive credential material/);
  assert.equal(shareCalls, 0);
});

test('MCP create_public_share rejects malformed note IDs before reading or publishing', async () => {
  let calls = 0;
  await assert.rejects(() => createPublicShareTool({
    async getNote() {
      calls += 1;
      throw new Error('must not be called');
    },
    async createPublicShare() {
      calls += 1;
      throw new Error('must not be called');
    },
  }, { noteId: 'not-a-uuid', expectedVersion: 1, confirm: true }), /noteId must be a valid UUID/);
  assert.equal(calls, 0);
});

test('MCP protocol exposes and invokes create_public_share only in the share-capable profiles', async () => {
  const noteId = '550e8400-e29b-41d4-a716-446655440001';
  const token = `qns_${'B'.repeat(43)}`;
  let received;
  const { client } = await connectedProtocol('share', protocolClient({
    async getNote() {
      return { id: noteId, title: 'Safe note', contentMarkdown: '# Safe', slug: 'safe', contentPlain: 'Safe', tags: [], notebookId: null, version: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null };
    },
    async createPublicShare(receivedNoteId, input) {
      received = { noteId: receivedNoteId, input };
      return { token, metadata: {} };
    },
  }));
  const invalid = await client.callTool({ name: 'create_public_share', arguments: { noteId: 'not-a-uuid' } });
  assert.equal(invalid.isError, true);
  const result = await client.callTool({ name: 'create_public_share', arguments: { noteId, expectedVersion: 1, confirm: true } });
  assert.deepEqual(received.noteId, noteId);
  assert.equal(typeof received.input.expiresAt, 'string');
  assert.equal(result.structuredContent.noteId, noteId);
  assert.equal(result.structuredContent.url, `https://notes.quadrate.lk/share#${token}`);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    url: `https://notes.quadrate.lk/share#${token}`,
    noteId,
    expiresAt: result.structuredContent.expiresAt,
  });
  assert.equal('contentMarkdown' in result.structuredContent, false);
  assert.equal(result.content[0].text.includes('Safe note'), false);
  await client.close();
});

test('MCP list_notebooks is available in the read profile and delegates to the API client', async () => {
  let calls = 0;
  const { client } = await connectedProtocol('read', protocolClient({
    async listNotebooks() {
      calls += 1;
      return { items: [{ id: 'notebook-1', name: 'Operations', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] };
    },
  }));
  const result = await client.callTool({ name: 'list_notebooks', arguments: {} });
  assert.deepEqual(result.structuredContent, { items: [{ id: 'notebook-1', name: 'Operations', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
  assert.equal(calls, 1);
  await client.close();
});

test('MCP collection results are bounded while keeping continuation metadata', async () => {
  const searchItem = {
    id: 'document-1', documentId: 'document-1', noteId: 'note-1', noteVersion: 1, noteSlug: 'note', noteTitle: 'Note',
    sourceType: 'note_chunk', sourceId: null, sourceKey: 'body', sourceTitle: 'Body', headingPath: null,
    snippet: 'x'.repeat(800), score: 1, keywordRank: 1, semanticRank: null, copyable: false, blockKey: null, language: null, attachmentId: null,
  };
  const { client } = await connectedProtocol('read', protocolClient({
    async searchPost() {
      return { items: Array.from({ length: 200 }, () => searchItem), queryId: 'query-1', modeUsed: 'keyword', degraded: false, nextCursor: 'search-after-1', timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
    },
    async listNotebooks() {
      return { items: Array.from({ length: 500 }, (_, index) => ({ id: `notebook-${index}`, name: 'n'.repeat(80), createdAt: '2026-01-01', updatedAt: '2026-01-01' })) };
    },
  }));
  const search = await client.callTool({ name: 'search_notes', arguments: { query: 'bounded' } });
  assert.equal(search.structuredContent.truncated, true);
  assert.equal(search.structuredContent.nextCursor, 'search-after-1');
  assert.ok(search.structuredContent.items.length < 200);
  const notebooks = await client.callTool({ name: 'list_notebooks', arguments: {} });
  assert.equal(notebooks.structuredContent.truncated, true);
  assert.ok(notebooks.structuredContent.items.length < 500);
  await client.close();
});

test('MCP bounding keeps a full item page when truncation metadata makes it fit', () => {
  const wireBytes = (value) => new TextEncoder().encode(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  })).byteLength;
  let low = 0;
  let high = MAX_MCP_TOOL_RESPONSE_BYTES;
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (wireBytes({ items: [{ value: 'x'.repeat(size) }], truncated: true }) <= MAX_MCP_TOOL_RESPONSE_BYTES) low = size;
    else high = size - 1;
  }
  const value = { items: [{ value: 'x'.repeat(low) }], truncated: false };
  assert.ok(wireBytes(value) > MAX_MCP_TOOL_RESPONSE_BYTES);
  const result = toolResult(value);
  assert.deepEqual(result.structuredContent, { items: value.items, truncated: true });
});

test('MCP resolve_public_share is read-only and delegates to the public API-client operation', async () => {
  let receivedToken;
  let receivedOptions;
  const token = 'qns_' + 'A'.repeat(43);
  const sharedNote = { title: 'Shared', contentMarkdown: '# Shared', updatedAt: '2026-01-01T00:00:00Z' };
  const { client } = await connectedProtocol('read', protocolClient({
    async resolvePublicShare(value, options) {
      receivedToken = value;
      receivedOptions = options;
      return sharedNote;
    },
  }));
  const result = await client.callTool({ name: 'resolve_public_share', arguments: { token } });
  assert.equal(receivedToken, token);
  assert.deepEqual(receivedOptions, { maxBytes: 15 * 1024 });
  assert.deepEqual(result.structuredContent, sharedNote);
  await client.close();
});

test('MCP write helpers avoid pre-reads and preserve omitted fields for the API', async () => {
  assert.equal(appendMarkdown('  keep indentation\n', '\n## Added\n\ntext\n'), '  keep indentation\n\n## Added\n\ntext\n');
  const calls = [];
  const client = {
    async getNote() { throw new Error('MCP write helper must not pre-read the note.'); },
    async appendNote(noteId, input) { calls.push({ operation: 'append', noteId, input }); return { id: noteId, title: 'Title', version: 4 }; },
    async updateNote(noteId, input) { calls.push({ operation: 'update', noteId, input }); return { id: noteId, title: 'Title', version: 4 }; },
  };
  const append = await appendNoteTool(client, { noteId: 'note-1', contentMarkdown: '\n## Added\n', mutationId: '660e8400-e29b-41d4-a716-446655440000' });
  const update = await updateNoteTool(client, { noteId: 'note-1', title: 'Title', slug: 'title', contentMarkdown: '# Replaced', expectedVersion: 3, mutationId: '660e8400-e29b-41d4-a716-446655440001' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.contentMarkdown, '\n## Added\n');
  assert.equal(Object.hasOwn(calls[0].input, 'expectedVersion'), false);
  assert.equal(Object.hasOwn(calls[1].input, 'tags'), false);
  assert.deepEqual(JSON.parse(append.content[0].text), {
    noteId: 'note-1', title: 'Title', resultingVersion: 4, mutationId: '660e8400-e29b-41d4-a716-446655440000', outcome: 'applied', uri: 'qnotes://notes/note-1',
  });
  assert.deepEqual(JSON.parse(update.content[0].text), {
    noteId: 'note-1', title: 'Title', resultingVersion: 4, mutationId: '660e8400-e29b-41d4-a716-446655440001', outcome: 'applied', uri: 'qnotes://notes/note-1',
  });
  assert.match(calls[0].input.deviceId, /^[0-9a-f-]{36}$/);
});

test('MCP capture accepts dedupe and notebook provenance without caller mutation IDs', async () => {
  let captured;
  const client = { async createNote(input) { captured = input; return { id: 'note-1', title: 'Captured', version: 1 }; } };
  const result = await captureNoteTool(client, { title: 'Captured', contentMarkdown: 'text', notebookId: null, dedupeKey: 'source:event:1' });
  assert.equal(captured.notebookId, null);
  assert.equal(captured.dedupeKey, 'source:event:1');
  assert.match(captured.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(captured.mutationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    noteId: 'note-1', title: 'Captured', resultingVersion: 1, mutationId: captured.mutationId, outcome: 'created', uri: 'qnotes://notes/note-1',
  });
});

function protocolClient(overrides = {}) {
  const note = { id: 'note-1', title: 'Rollback', slug: 'rollback', contentMarkdown: '# Rollback', contentPlain: 'Rollback', tags: ['ops'], notebookId: null, version: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null };
  return {
    async searchPost(input) { return { items: [], queryId: 'query-1', modeUsed: input.mode, degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } }; },
    async readNoteContext() { return context; },
    async getBlock(noteRef, blockKey) { return { id: 'block-1', noteId: noteRef, blockKey, blockType: 'command', title: 'Rollback', language: 'bash', content: 'docker compose down', position: 0, copyable: true, contentHash: 'hash' }; },
    async listNotebooks() { return { items: [] }; },
    async listNotes() { return { items: [{ id: note.id, slug: note.slug, title: note.title }], nextCursor: null }; },
    async getNote() { return note; },
    async createNoteDetailed(input) { return { note: { ...note, title: input.title }, outcome: 'created' }; },
    async createNote(input) { return { ...note, title: input.title }; },
    async appendNote(noteId, input) { return { ...note, id: noteId, version: note.version + 1, contentMarkdown: `${note.contentMarkdown}\n\n${input.contentMarkdown}\n` }; },
    async updateNote(noteId, input) { return { ...note, id: noteId, ...input }; },
    async deleteNote(noteId, input) { return { ...note, id: noteId, version: input.expectedVersion + 1, deletedAt: '2026-01-01T00:00:01Z' }; },
    async restoreNote(noteId, input) { return { ...note, id: noteId, version: input.expectedVersion + 1, deletedAt: null }; },
    async moveNoteToNotebook(noteId, input) { return { ...note, id: noteId, notebookId: input.notebookId, version: input.expectedVersion + 1 }; },
    ...overrides,
  };
}

async function connectedProtocol(profile, apiClient, options = {}) {
  const server = createQNotesMcpServer(apiClient, profile, options);
  const client = new Client({ name: 'qnotes-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('MCP protocol advertises the exact read and write tool profiles', async () => {
  const read = await connectedProtocol('read', protocolClient());
  const readTools = await read.client.listTools();
  assert.deepEqual(readTools.tools.map((tool) => tool.name), READ_TOOL_NAMES);
  await read.client.close();

  const share = await connectedProtocol('share', protocolClient());
  const shareTools = await share.client.listTools();
  assert.deepEqual(shareTools.tools.map((tool) => tool.name), SHARE_PROFILE_TOOL_NAMES);
  assert.equal(shareTools.tools.some((tool) => tool.name === 'delete_note'), false);
  assert.equal(shareTools.tools.some((tool) => tool.name === 'update_note'), false);
  await share.client.close();

  const write = await connectedProtocol('write', protocolClient());
  const writeTools = await write.client.listTools();
  assert.deepEqual(writeTools.tools.map((tool) => tool.name), WRITE_PROFILE_TOOL_NAMES);
  assert.equal(writeTools.tools.some((tool) => tool.name === 'create_public_share'), false);
  assert.deepEqual(WRITE_TOOL_NAMES, ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook']);
  const deleteTool = writeTools.tools.find((tool) => tool.name === 'delete_note');
  assert.match(JSON.stringify(deleteTool.inputSchema), /confirm/);
  assert.match(JSON.stringify(deleteTool.inputSchema), /true/);
  const readAgain = await connectedProtocol('read', protocolClient());
  const readToolNames = (await readAgain.client.listTools()).tools.map((tool) => tool.name);
  assert.equal(readToolNames.includes('delete_note'), false);
  assert.equal(readToolNames.includes('restore_note'), false);
  assert.equal(readToolNames.includes('move_note_to_notebook'), false);
  assert.equal(readToolNames.includes('create_notebook'), false);
  await readAgain.client.close();
  await write.client.close();
});

test('MCP transport publishes object output contracts and rejects unknown nested input before client calls', async () => {
  let calls = 0;
  const { client } = await connectedProtocol('read', protocolClient({
    async searchPost(input) {
      calls += 1;
      return { items: [], queryId: 'query-1', modeUsed: input.mode, degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
    },
  }));
  const tools = await client.listTools();
  for (const name of READ_TOOL_NAMES) {
    const tool = tools.tools.find((entry) => entry.name === name);
    assert.equal(tool.outputSchema.type, 'object');
  }
  const invalid = await client.callTool({ name: 'search_notes', arguments: { query: 'safe', filters: { tags: ['ops'], unexpected: true } } });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 0);
  await client.close();
});

test('MCP execution errors are stable, request-correlated, and redact provider details', async () => {
  const { client } = await connectedProtocol('read', protocolClient({
    async searchPost() {
      throw new Error('provider leaked synthetic-secret and note body');
    },
  }));
  const result = await client.callTool({ name: 'search_notes', arguments: { query: 'safe' } });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.equal(result.structuredContent.error.retryable, false);
  assert.match(result.structuredContent.error.requestId, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(result.content[0].text, /synthetic-secret|note body/);
  await client.close();
});

test('hosted qnotes-mcp passes no Vault options and exposes only Notes tools', async () => {
  const hostedSource = await readFile(new URL('../../../supabase/functions/qnotes-mcp/index.ts', import.meta.url), 'utf8');
  assert.match(hostedSource, /const server = createQNotesMcpServer\(client, HOSTED_MCP_PROFILE\);/);
  assert.doesNotMatch(hostedSource, /\b(?:QVaultClient|QVAULT_[A-Z_]+|vaultClient|vaultProfile|vault_[a-z_]+)\b/);

  for (const profile of ['read', 'share']) {
    const { client } = await connectedProtocol(profile, protocolClient());
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), PROFILE_TOOL_NAMES[profile]);
    assert.equal(tools.tools.some((tool) => tool.name.startsWith('vault_')), false);
    await client.close();
  }
});

test('MCP write profile registers create_public_share only with the explicit capability', async () => {
  const { client } = await connectedProtocol('write', protocolClient(), { allowPublicShare: true });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [...READ_TOOL_NAMES, ...SHARE_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
  assert.equal(tools.tools.some((tool) => tool.name === 'create_public_share'), true);
  await client.close();
});

test('MCP move_note_to_notebook uses the API client and preserves transactional identities', async () => {
  let received;
  const stableDeviceId = '770e8400-e29b-41d4-a716-446655440000';
  const mutationId = '660e8400-e29b-41d4-a716-446655440012';
  const { client } = await connectedProtocol('write', protocolClient({
    async moveNoteToNotebook(noteId, input) {
      received = { noteId, input };
      return { id: noteId, title: 'Rollback', version: input.expectedVersion + 1, notebookId: input.notebookId };
    },
  }), { deviceId: stableDeviceId });
  const result = await client.callTool({ name: 'move_note_to_notebook', arguments: {
    noteId: '550e8400-e29b-41d4-a716-446655440000',
    notebookId: null,
    expectedVersion: 3,
    mutationId,
  } });
  assert.deepEqual(received, {
    noteId: '550e8400-e29b-41d4-a716-446655440000',
    input: { notebookId: null, expectedVersion: 3, deviceId: stableDeviceId, mutationId },
  });
  assert.deepEqual(result.structuredContent, {
    noteId: '550e8400-e29b-41d4-a716-446655440000', title: 'Rollback', resultingVersion: 4, mutationId, outcome: 'applied', uri: 'qnotes://notes/550e8400-e29b-41d4-a716-446655440000',
  });
  await client.close();
});

test('MCP append exposes a caller-owned retry identity and expected version', async () => {
  let appendInput;
  const { client } = await connectedProtocol('write', protocolClient({
    async getNote() { throw new Error('append_note must not pre-read'); },
    async appendNote(_noteId, input) { appendInput = input; return { id: 'note-1', title: 'Rollback', version: 4 }; },
  }));
  const result = await client.callTool({ name: 'append_note', arguments: {
    noteId: '550e8400-e29b-41d4-a716-446655440000', contentMarkdown: 'Added', expectedVersion: 3, mutationId: '660e8400-e29b-41d4-a716-446655440000',
  } });
  assert.deepEqual(result.structuredContent, {
    noteId: 'note-1', title: 'Rollback', resultingVersion: 4, mutationId: '660e8400-e29b-41d4-a716-446655440000', outcome: 'applied', uri: 'qnotes://notes/note-1',
  });
  assert.deepEqual(appendInput, {
    contentMarkdown: 'Added', expectedVersion: 3, deviceId: appendInput.deviceId, mutationId: '660e8400-e29b-41d4-a716-446655440000',
  });
  assert.match(appendInput.deviceId, /^[0-9a-f-]{36}$/);
  await client.close();
});

test('MCP write options preserve the configured device identity', async () => {
  let appendInput;
  const stableDeviceId = '770e8400-e29b-41d4-a716-446655440000';
  const { client } = await connectedProtocol('write', protocolClient({
    async appendNote(_noteId, input) { appendInput = input; return { id: 'note-1', version: 4, contentMarkdown: '# Rollback\n\nAdded\n' }; },
  }), { deviceId: stableDeviceId });
  await client.callTool({ name: 'append_note', arguments: {
    noteId: '550e8400-e29b-41d4-a716-446655440000', contentMarkdown: 'Added', mutationId: '660e8400-e29b-41d4-a716-446655440000',
  } });
  assert.equal(appendInput.deviceId, stableDeviceId);
  assert.equal(appendInput.mutationId, '660e8400-e29b-41d4-a716-446655440000');
  await client.close();
});

test('MCP protocol calls preserve filters, structured content, outcomes, and validation limits', async () => {
  let searchInput;
  const apiClient = protocolClient({
    async searchPost(input) {
      searchInput = input;
      return { items: [], queryId: 'query-2', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
    },
    async createNoteDetailed(input) { return { note: { id: 'note-1', slug: 'captured', title: input.title, contentMarkdown: '', contentPlain: '', tags: [], notebookId: null, version: 7, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null }, outcome: 'deduplicated' }; },
  });
  const { client } = await connectedProtocol('write', apiClient);
  const search = await client.callTool({ name: 'search_notes', arguments: {
    query: 'rollback', limit: 500, cursor: 'opaque-cursor', filters: {
      notebookIds: ['550e8400-e29b-41d4-a716-446655440000'], tags: ['ops'], sourceTypes: ['code_block'], languages: ['bash'],
      updatedAfter: '2026-01-01T00:00:00.000Z', unfiled: false,
    },
  } });
  assert.deepEqual(search.structuredContent, { items: [], queryId: 'query-2', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } });
  assert.deepEqual(searchInput.filters, {
    notebookIds: ['550e8400-e29b-41d4-a716-446655440000'], tags: ['ops'], sourceTypes: ['code_block'], languages: ['bash'],
    updatedAfter: '2026-01-01T00:00:00.000Z', unfiled: false,
  });
  assert.equal(searchInput.limit, 500);
  assert.equal(searchInput.cursor, 'opaque-cursor');
  const capture = await client.callTool({ name: 'capture_note', arguments: { title: 'Captured', contentMarkdown: '', dedupeKey: 'source:event:1' } });
  assert.equal(capture.structuredContent.noteId, 'note-1');
  assert.equal(capture.structuredContent.title, 'Captured');
  assert.equal(capture.structuredContent.resultingVersion, 7);
  assert.equal(capture.structuredContent.outcome, 'deduplicated');
  assert.equal('contentMarkdown' in capture.structuredContent, false);
  assert.equal('contentPlain' in capture.structuredContent, false);
  assert.equal('blocks' in capture.structuredContent, false);
  await client.close();
});

test('MCP delete and restore wrappers require confirmation and preserve mutation identity', async () => {
  const calls = [];
  const note = { id: 'note-1', title: 'Rollback', version: 4 };
  const client = {
    async deleteNote(noteId, input) { calls.push({ operation: 'delete', noteId, input }); return note; },
    async restoreNote(noteId, input) { calls.push({ operation: 'restore', noteId, input }); return { ...note, version: 5 }; },
  };
  const deleted = await deleteNoteTool(client, { noteId: 'note-1', expectedVersion: 4, confirm: true, mutationId: '660e8400-e29b-41d4-a716-446655440010' }, { deviceId: '770e8400-e29b-41d4-a716-446655440000' });
  const restored = await restoreNoteTool(client, { noteId: 'note-1', expectedVersion: 5, confirm: true, mutationId: '660e8400-e29b-41d4-a716-446655440011' }, { deviceId: '770e8400-e29b-41d4-a716-446655440000' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ operation, input }) => ({ operation, input })), [
    { operation: 'delete', input: { expectedVersion: 4, deviceId: '770e8400-e29b-41d4-a716-446655440000', mutationId: '660e8400-e29b-41d4-a716-446655440010' } },
    { operation: 'restore', input: { expectedVersion: 5, deviceId: '770e8400-e29b-41d4-a716-446655440000', mutationId: '660e8400-e29b-41d4-a716-446655440011' } },
  ]);
  assert.equal(deleted.structuredContent.outcome, 'applied');
  assert.equal(restored.structuredContent.outcome, 'applied');
  await assert.rejects(() => deleteNoteTool(client, { noteId: 'note-1', expectedVersion: 4, confirm: false }), /confirm must be true/);
});

test('MCP resources read notes, documents, and blocks and reject mismatched provenance', async () => {
  const apiClient = protocolClient({ async getBlock() { return { id: 'block-1', noteId: 'note-1', blockKey: 'rollback', blockType: 'command', title: 'Rollback', language: 'bash', content: 'docker compose down', position: 0, copyable: true, contentHash: 'hash' }; } });
  const { client } = await connectedProtocol('read', apiClient);
  const note = await client.readResource({ uri: 'qnotes://notes/note-1' });
  assert.equal(JSON.parse(note.contents[0].text).id, 'note-1');
  const document = await client.readResource({ uri: 'qnotes://notes/note-1/documents/doc-1' });
  assert.equal(JSON.parse(document.contents[0].text).documentId, 'doc-1');
  const block = await client.readResource({ uri: 'qnotes://notes/note-1/blocks/rollback' });
  assert.equal(JSON.parse(block.contents[0].text).blockKey, 'rollback');
  await assert.rejects(() => client.readResource({ uri: 'qnotes://notes/other/documents/doc-1' }));
  await assert.rejects(() => client.readResource({ uri: 'qnotes://notes/other/blocks/rollback' }));
  await client.close();
});

test('MCP note resources advertise a recent partial page and forward its cursor', async () => {
  const listNotesCalls = [];
  const { client } = await connectedProtocol('read', protocolClient({
    async listNotes(params) {
      listNotesCalls.push(params);
      return {
        items: [{ id: 'note-1', slug: 'rollback', title: 'Rollback' }],
        nextCursor: params.cursor ? null : 'notes-after-1',
      };
    },
  }));

  const firstPage = await client.listResources();
  const noteResource = firstPage.resources.find((resource) => resource.uri === 'qnotes://notes/note-1');
  assert.ok(noteResource);
  assert.equal(firstPage.nextCursor, 'notes-after-1');
  assert.match(noteResource.description, /recent/i);
  assert.match(noteResource.description, /partial/i);
  assert.equal('contentMarkdown' in noteResource, false);
  assert.deepEqual(listNotesCalls, [{ limit: 50 }]);

  const secondPage = await client.listResources({ cursor: firstPage.nextCursor });
  assert.equal(secondPage.nextCursor, undefined);
  assert.deepEqual(listNotesCalls, [{ limit: 50 }, { limit: 50, cursor: 'notes-after-1' }]);
  await client.close();
});
