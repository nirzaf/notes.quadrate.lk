import test from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilitiesTool, getMutationStatusTool, getNoteOutlineTool, listNoteChangesTool, patchNoteSectionTool, previewNoteSectionTool } from '../dist/tools/editing.js';

const note = { id: 'note-1', title: 'Note', version: 2 };
const capabilities = { schemaVersion: 1, effectiveProfile: 'read', scopes: ['notes:read'], supportedOperations: ['get_capabilities'], responseLimits: { searchResults: 500, contextTokens: 4000, noteChanges: 500, outlineSections: 500, patchReplacementBytes: 200000 } };
const outline = { noteId: 'note-1', noteVersion: 2, markdownHash: 'a'.repeat(64), sections: [], blocks: [], truncated: false };

test('MCP editing tools preserve bounded discovery and caller-owned mutation identity', async () => {
  const calls = [];
  const client = {
    async getCapabilities() { return capabilities; },
    async getNoteOutline(noteRef) { calls.push({ operation: 'outline', noteRef }); return outline; },
    async getMutationStatus(mutationId) { calls.push({ operation: 'status', mutationId }); return { mutationId, operation: 'updated', noteId: 'note-1', resultingVersion: 2, createdAt: '2026-01-01', status: 'committed' }; },
    async sync(cursor, limit) { calls.push({ operation: 'sync', cursor, limit }); return { changes: [], nextCursor: null, hasMore: false }; },
    async previewNoteSection(noteId, input) { calls.push({ operation: 'preview', noteId, input }); return { noteId, currentVersion: 2, sectionId: input.sectionId, currentContentHash: input.expectedContentHash, replacementBytes: 7, resultingMarkdownHash: 'b'.repeat(64), wouldChange: true }; },
    async patchNoteSection(noteId, input) { calls.push({ operation: 'patch', noteId, input }); return { note, outcome: 'applied' }; },
  };
  const discovered = await getCapabilitiesTool(client, 'write', ['get_capabilities', 'patch_note_section']);
  const listed = await getNoteOutlineTool(client, { noteRef: 'note-1' });
  const status = await getMutationStatusTool(client, { mutationId: '550e8400-e29b-41d4-a716-446655440000' });
  const changes = await listNoteChangesTool(client, {});
  const preview = await previewNoteSectionTool(client, { noteId: 'note-1', sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', mutationId: '550e8400-e29b-41d4-a716-446655440005' }, { deviceId: '550e8400-e29b-41d4-a716-446655440002' });
  const patch = await patchNoteSectionTool(client, { noteId: 'note-1', sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', mutationId: '550e8400-e29b-41d4-a716-446655440001' }, { deviceId: '550e8400-e29b-41d4-a716-446655440002' });

  assert.equal(discovered.structuredContent.effectiveProfile, 'read');
  assert.deepEqual(discovered.structuredContent.supportedOperations, ['get_capabilities']);
  assert.deepEqual(listed.structuredContent, outline);
  assert.equal(status.structuredContent.status, 'committed');
  assert.deepEqual(changes.structuredContent, { changes: [], nextCursor: null, hasMore: false });
  assert.equal(preview.structuredContent.wouldChange, true);
  assert.equal(patch.structuredContent.mutationId, '550e8400-e29b-41d4-a716-446655440001');
  await patchNoteSectionTool(client, { noteId: 'note-1', sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', mutationId: '550e8400-e29b-41d4-a716-446655440003' });
  await patchNoteSectionTool(client, { noteId: 'note-1', sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', mutationId: '550e8400-e29b-41d4-a716-446655440004' });
  assert.equal(calls[5].input.deviceId, calls[6].input.deviceId);
  assert.deepEqual(calls, [
    { operation: 'outline', noteRef: 'note-1' },
    { operation: 'status', mutationId: '550e8400-e29b-41d4-a716-446655440000' },
    { operation: 'sync', cursor: undefined, limit: 200 },
    { operation: 'preview', noteId: 'note-1', input: { sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', deviceId: '550e8400-e29b-41d4-a716-446655440002', mutationId: '550e8400-e29b-41d4-a716-446655440005' } },
    { operation: 'patch', noteId: 'note-1', input: { sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', deviceId: '550e8400-e29b-41d4-a716-446655440002', mutationId: '550e8400-e29b-41d4-a716-446655440001' } },
    { operation: 'patch', noteId: 'note-1', input: { sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', deviceId: calls[5].input.deviceId, mutationId: '550e8400-e29b-41d4-a716-446655440003' } },
    { operation: 'patch', noteId: 'note-1', input: { sectionId: 'section-1', expectedVersion: 2, expectedContentHash: 'a'.repeat(64), replacementMarkdown: 'changed', deviceId: calls[5].input.deviceId, mutationId: '550e8400-e29b-41d4-a716-446655440004' } },
  ]);
});
