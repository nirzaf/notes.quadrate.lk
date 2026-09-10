import test from 'node:test';
import assert from 'node:assert/strict';
import { QNotesClient } from '../dist/index.js';

function jsonResponse(data, headers = {}) {
  return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json', ...headers } });
}

const note = {
  id: '550e8400-e29b-41d4-a716-446655440000', slug: 'note', title: 'Note', contentMarkdown: '# Note', contentPlain: 'Note', tags: [], notebookId: null,
  version: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', deletedAt: null,
};
const digest = 'a'.repeat(64);

test('discovers capabilities, outlines, mutation receipts, changes, and exact section patches', async () => {
  const calls = [];
  const client = new QNotesClient({ baseUrl: 'https://example.test', getAccessToken: () => 'token', fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/capabilities')) return jsonResponse({ schemaVersion: 1, effectiveProfile: 'write', scopes: ['notes:read', 'notes:write'], supportedOperations: ['get_capabilities'], responseLimits: { searchResults: 500, contextTokens: 4000, noteChanges: 500, outlineSections: 500, patchReplacementBytes: 200000 } });
    if (url.endsWith('/outline')) return jsonResponse({ noteId: note.id, noteVersion: 1, markdownHash: digest, sections: [{ sectionId: 'section-1', level: 2, heading: 'Body', headingPath: ['Note', 'Body'], startLine: 3, endLine: 5, contentStartLine: 4, contentEndLine: 5, contentHash: digest, childCount: 0 }], blocks: [], truncated: false });
    if (url.endsWith('/section/preview')) return jsonResponse({ noteId: note.id, currentVersion: 1, sectionId: 'section-1', currentContentHash: digest, replacementBytes: 7, resultingMarkdownHash: digest, wouldChange: true });
    if (url.endsWith('/section')) return jsonResponse(note, { 'x-qnotes-mutation-outcome': 'applied' });
    if (url.endsWith('/mutations/mutation-1')) return jsonResponse({ mutationId: 'mutation-1', operation: 'updated', noteId: note.id, resultingVersion: 2, createdAt: '2026-01-01T00:00:01Z', status: 'committed' });
    return jsonResponse({ changes: [{ noteId: note.id, slug: note.slug, title: note.title, tags: [], notebookId: null, version: 2, updatedAt: note.updatedAt, deletedAt: null }], nextCursor: null, hasMore: false });
  } });

  assert.equal((await client.getCapabilities()).responseLimits.patchReplacementBytes, 200000);
  assert.equal((await client.getNoteOutline(note.id)).sections[0].sectionId, 'section-1');
  assert.equal((await client.previewNoteSection(note.id, { sectionId: 'section-1', expectedVersion: 1, expectedContentHash: digest, replacementMarkdown: 'changed', deviceId: '550e8400-e29b-41d4-a716-446655440001', mutationId: '550e8400-e29b-41d4-a716-446655440002' })).wouldChange, true);
  const patched = await client.patchNoteSection(note.id, { sectionId: 'section-1', expectedVersion: 1, expectedContentHash: digest, replacementMarkdown: 'changed', deviceId: '550e8400-e29b-41d4-a716-446655440001', mutationId: '550e8400-e29b-41d4-a716-446655440002' });
  assert.equal(patched.outcome, 'applied');
  assert.equal((await client.getMutationStatus('mutation-1')).status, 'committed');
  assert.equal((await client.sync(undefined, 10)).changes.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/capabilities');
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[3].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[3].init.body), { sectionId: 'section-1', expectedVersion: 1, expectedContentHash: digest, replacementMarkdown: 'changed', deviceId: '550e8400-e29b-41d4-a716-446655440001', mutationId: '550e8400-e29b-41d4-a716-446655440002' });
  assert.equal(calls[5].url, 'https://example.test/api/sync?limit=10');
});
