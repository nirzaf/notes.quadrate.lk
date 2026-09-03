import test from 'node:test';
import assert from 'node:assert/strict';
import { getBlockTool } from '../dist/tools/get-block.js';
import { readNoteContextTool } from '../dist/tools/read-note-context.js';
import { searchNotesTool } from '../dist/tools/search-notes.js';
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
