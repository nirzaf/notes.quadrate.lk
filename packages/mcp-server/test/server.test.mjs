import test from 'node:test';
import assert from 'node:assert/strict';
import { getBlockTool } from '../dist/tools/get-block.js';
import { readNoteContextTool } from '../dist/tools/read-note-context.js';
import { searchNotesTool } from '../dist/tools/search-notes.js';
import { appendNoteTool, captureNoteTool, updateNoteTool } from '../dist/tools/write-notes.js';
import { appendMarkdown } from '../dist/tools/common.js';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES, createQNotesMcpServer } from '../dist/server.js';
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
      assert.deepEqual(params, { before: 1, after: 2, maxTokens: 900 });
      return context;
    },
    async getBlock(noteRef, blockKey) {
      assert.equal(noteRef, 'note-1');
      assert.equal(blockKey, 'rollback');
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

test('default MCP profile exposes only the read surface', () => {
  const server = createQNotesMcpServer(mockClient());
  assert.ok(server);
  assert.deepEqual(READ_TOOL_NAMES, ['search_notes', 'read_note_context', 'get_block']);
});

test('MCP write helpers preserve markdown boundaries and omitted tags', async () => {
  assert.equal(appendMarkdown('  keep indentation\n', '\n## Added\n\ntext\n'), '  keep indentation\n\n## Added\n\ntext\n');
  const calls = [];
  const client = {
    async getNote() { return { id: 'note-1', title: 'Title', slug: 'title', contentMarkdown: '# Existing\n', contentPlain: 'Existing', tags: ['ops'], notebookId: null, version: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null }; },
    async updateNote(noteId, input) { calls.push({ noteId, input }); return { id: noteId, ...input }; },
  };
  await appendNoteTool(client, { noteId: 'note-1', contentMarkdown: '\n## Added\n' });
  await updateNoteTool(client, { noteId: 'note-1', title: 'Title', slug: 'title', contentMarkdown: '# Replaced', expectedVersion: 3 });
  assert.equal(calls[0].input.contentMarkdown, '# Existing\n\n## Added\n');
  assert.deepEqual(calls[1].input.tags, ['ops']);
  assert.match(calls[0].input.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(calls[0].input.mutationId, /^[0-9a-f-]{36}$/);
});

test('MCP capture accepts dedupe and notebook provenance without caller mutation IDs', async () => {
  let captured;
  const client = { async createNote(input) { captured = input; return { id: 'note-1', ...input }; } };
  await captureNoteTool(client, { title: 'Captured', contentMarkdown: 'text', notebookId: null, dedupeKey: 'source:event:1' });
  assert.equal(captured.notebookId, null);
  assert.equal(captured.dedupeKey, 'source:event:1');
  assert.match(captured.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(captured.mutationId, /^[0-9a-f-]{36}$/);
});

function protocolClient(overrides = {}) {
  const note = { id: 'note-1', title: 'Rollback', slug: 'rollback', contentMarkdown: '# Rollback', contentPlain: 'Rollback', tags: ['ops'], notebookId: null, version: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null };
  return {
    async searchPost(input) { return { items: [], queryId: 'query-1', modeUsed: input.mode, degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } }; },
    async readNoteContext() { return context; },
    async getBlock(noteRef, blockKey) { return { id: 'block-1', noteId: noteRef, blockKey, blockType: 'command', title: 'Rollback', language: 'bash', content: 'docker compose down', position: 0, copyable: true, contentHash: 'hash' }; },
    async listNotebooks() { return { items: [] }; },
    async listNotes() { return { items: [{ id: note.id, slug: note.slug, title: note.title }] }; },
    async getNote() { return note; },
    async createNoteDetailed(input) { return { note: { ...note, title: input.title }, outcome: 'created' }; },
    async createNote(input) { return { ...note, title: input.title }; },
    async updateNote(noteId, input) { return { ...note, id: noteId, ...input }; },
    ...overrides,
  };
}

async function connectedProtocol(profile, apiClient) {
  const server = createQNotesMcpServer(apiClient, profile);
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

  const write = await connectedProtocol('write', protocolClient());
  const writeTools = await write.client.listTools();
  assert.deepEqual(writeTools.tools.map((tool) => tool.name), [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
  await write.client.close();
});

test('MCP protocol calls preserve filters, structured content, outcomes, and validation limits', async () => {
  let searchInput;
  const apiClient = protocolClient({
    async searchPost(input) {
      searchInput = input;
      return { items: [], queryId: 'query-2', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
    },
    async createNoteDetailed() { return { note: { id: 'note-1' }, outcome: 'deduplicated' }; },
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
  assert.deepEqual(capture.structuredContent, { note: { id: 'note-1' }, outcome: 'deduplicated' });
  await client.close();
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
