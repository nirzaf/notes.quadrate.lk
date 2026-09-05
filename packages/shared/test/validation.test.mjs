import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesMcpConfig } from '../dist/hermes.js';
import { resolveAutoSearchMode, validateAppendNoteInput, validateCreateNoteInput, validateListNotesQuery, validateSearchRequest, validateUpdateNoteInput } from '../dist/validation.js';

test('auto mode uses keyword retrieval for identifiers and quoted phrases', () => {
  assert.equal(resolveAutoSearchMode('production-rollback'), 'keyword');
  assert.equal(resolveAutoSearchMode('"Emergency rollback"'), 'keyword');
  assert.equal(resolveAutoSearchMode('550e8400-e29b-41d4-a716-446655440000'), 'keyword');
});

test('auto mode uses hybrid retrieval for natural-language questions', () => {
  assert.equal(resolveAutoSearchMode('How do I roll back ERPNext in production?'), 'hybrid');
});

test('validates structured POST search filters and bounds', () => {
  assert.deepEqual(validateSearchRequest({
    query: 'rollback production',
    mode: 'auto',
    limit: 10,
    maxPerNote: 2,
    filters: {
      notebookIds: ['550e8400-e29b-41d4-a716-446655440000'],
      tags: [' Operations ', 'operations'],
      sourceTypes: ['note_chunk', 'code_block'],
      languages: ['Bash'],
      updatedAfter: '2026-01-01T00:00:00.000Z',
      unfiled: false,
    },
    minimumRelativeScore: 0.45,
    cursor: 'cursor-1',
  }), {
    query: 'rollback production',
    mode: 'auto',
    limit: 10,
    maxPerNote: 2,
    filters: {
      notebookIds: ['550e8400-e29b-41d4-a716-446655440000'],
      tags: ['operations'],
      sourceTypes: ['note_chunk', 'code_block'],
      languages: ['bash'],
      updatedAfter: '2026-01-01T00:00:00.000Z',
      unfiled: false,
    },
    minimumRelativeScore: 0.45,
    cursor: 'cursor-1',
  });
});

test('accepts the maximum search page and rejects values above it', () => {
  assert.equal(validateSearchRequest({ query: 'rollback', limit: 500 }).limit, 500);
  assert.throws(() => validateSearchRequest({ query: 'rollback', limit: 501 }), /limit must be an integer from 1 to 500/);
});

test('preserves optional write fields and normalizes capture dedupe metadata', () => {
  const notebookId = '550e8400-e29b-41d4-a716-446655440000';
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const mutationId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(validateCreateNoteInput({ title: ' Capture ', contentMarkdown: '', tags: ['Ops'], notebookId, dedupeKey: ' source:event:1 ', deviceId, mutationId }), {
    title: 'Capture', contentMarkdown: '', tags: ['ops'], notebookId, dedupeKey: 'source:event:1', deviceId, mutationId,
  });
  const update = validateUpdateNoteInput({ title: 'Title', slug: 'title', contentMarkdown: '# body', expectedVersion: 2, deviceId, mutationId });
  assert.equal('tags' in update, false);
});

test('validates complete note-list filters before pagination', () => {
  const notebookId = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(validateListNotesQuery({ limit: '25', notebookId, tag: ' Operations ', includeDeleted: 'false', deletedOnly: 'false', unfiled: 'false', cursor: 'cursor-1' }), {
    limit: 25, notebookId, tag: 'operations', includeDeleted: false, deletedOnly: false, unfiled: false, cursor: 'cursor-1',
  });
  assert.deepEqual(validateListNotesQuery({ unfiled: 'true', deletedOnly: 'true' }), {
    limit: 50, includeDeleted: false, deletedOnly: true, unfiled: true,
  });
  assert.throws(() => validateListNotesQuery({ notebookId, unfiled: true }), /cannot be used together/);
  assert.throws(() => validateListNotesQuery({ notebookId: 'not-a-uuid' }), /valid UUID/);
});

test('validates optional append versions and generates a parseable Hermes config', () => {
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const mutationId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(validateAppendNoteInput({ contentMarkdown: 'added\r\n', deviceId, mutationId }), { contentMarkdown: 'added\n', deviceId, mutationId });
  assert.equal(validateAppendNoteInput({ contentMarkdown: 'added', expectedVersion: 3, deviceId, mutationId }).expectedVersion, 3);
  assert.throws(() => validateAppendNoteInput({ contentMarkdown: 'added', expectedVersion: 0, deviceId, mutationId }), /positive integer/);
  const config = JSON.parse(buildHermesMcpConfig({ profile: 'write', serverPath: '/repo/packages/mcp-server/dist/index.js', deviceId }));
  assert.deepEqual(config.mcp_servers.quadrate_notes_write.env, {
    QNOTES_URL: '${QNOTES_URL}', QNOTES_MCP_PROFILE: 'write', QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}', QNOTES_MCP_DEVICE_ID: deviceId,
  });
  assert.deepEqual(config.mcp_servers.quadrate_notes_write.tools.include, ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note']);
  assert.throws(() => buildHermesMcpConfig({ profile: 'write', serverPath: '/repo/server.js' }), /stable UUID/);
});
