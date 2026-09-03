import test from 'node:test';
import assert from 'node:assert/strict';
import { getBlockTool } from '../dist/tools/get-block.js';
import { readNoteContextTool } from '../dist/tools/read-note-context.js';
import { searchNotesTool } from '../dist/tools/search-notes.js';
import { appendNoteTool, captureNoteTool, updateNoteTool } from '../dist/tools/write-notes.js';
import { appendMarkdown } from '../dist/tools/common.js';
import { READ_TOOL_NAMES, createQNotesMcpServer } from '../dist/server.js';

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
