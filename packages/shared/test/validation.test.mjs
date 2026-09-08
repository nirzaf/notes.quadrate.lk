import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesMcpConfig } from '../dist/hermes.js';
import { approximateContextTokens, boundContextContent, boundContextSource, contextNoteChanged, contextTokenUsage, takeContextSources } from '../dist/context.js';
import { resolveAutoSearchMode, validateAppendNoteInput, validateCreateNoteInput, validateListNotesQuery, validateSearchRequest, validateTokenInput, validateUpdateNoteInput } from '../dist/validation.js';

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
  assert.deepEqual(config.mcp_servers.quadrate_notes_write.tools.include, ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share', 'capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook']);
  assert.throws(() => buildHermesMcpConfig({ profile: 'write', serverPath: '/repo/server.js' }), /stable UUID/);
});

test('accepts the least-privilege share scope and generates a share MCP profile', () => {
  assert.deepEqual(validateTokenInput({ name: 'Share agent', scopes: ['notes:read', 'search:read', 'shares:write'], expiresAt: null }).scopes, ['notes:read', 'search:read', 'shares:write']);
  const config = JSON.parse(buildHermesMcpConfig({ profile: 'share', serverPath: '/repo/packages/mcp-server/dist/index.js' }));
  assert.deepEqual(config.mcp_servers.quadrate_notes_share.env, { QNOTES_URL: '${QNOTES_URL}', QNOTES_TOKEN: '${QNOTES_TOKEN}' });
  assert.deepEqual(config.mcp_servers.quadrate_notes_share.tools.include, ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share', 'create_public_share']);
});

test('bounds context content without an implicit ellipsis and reports truncation', () => {
  assert.deepEqual(boundContextContent('abcdefghij', 2), { content: 'abcdefgh', truncated: true });
  assert.deepEqual(boundContextContent('abcdefgh', 2), { content: 'abcdefgh', truncated: false });
});

test('accounts for Unicode by code point while keeping the approximate token budget bounded', () => {
  const value = '😀😀😀😀😀';
  const bounded = boundContextContent(value, 1);
  assert.equal(bounded.content, '😀😀😀😀');
  assert.equal([...bounded.content].length, 4);
  assert.equal(approximateContextTokens(bounded.content), 1);
  assert.equal(contextTokenUsage(bounded.content), 1);
});

test('keeps provenance separate for bounded neighboring sources', () => {
  const source = (documentId, sourceHash, content) => ({
    documentId, noteId: 'note-1', noteVersion: 7, sourceType: 'note_chunk', sourceId: null,
    sourceKey: documentId, sourceTitle: documentId, headingPath: null, attachmentId: null, pageNumber: null,
    content, sourceHash,
  });
  const previous = takeContextSources([source('previous-doc', 'previous-hash', 'previous content')], 10);
  const next = takeContextSources([source('next-doc', 'next-hash', 'next content')], 10);
  assert.equal(previous[0].documentId, 'previous-doc');
  assert.equal(previous[0].sourceHash, 'previous-hash');
  assert.equal(previous[0].content, 'previous content');
  assert.equal(next[0].documentId, 'next-doc');
  assert.equal(next[0].sourceHash, 'next-hash');
  assert.equal(next[0].content, 'next content');
  assert.equal(boundContextSource(source('center-doc', 'center-hash', 'center'), 10).sourceHash, 'center-hash');
});

test('detects stale context snapshots by version or updated timestamp', () => {
  const snapshot = { version: 3, updatedAt: '2026-01-01T00:00:00Z' };
  assert.equal(contextNoteChanged(snapshot, snapshot), false);
  assert.equal(contextNoteChanged(snapshot, { version: 4, updatedAt: snapshot.updatedAt }), true);
  assert.equal(contextNoteChanged(snapshot, { version: snapshot.version, updatedAt: '2026-01-01T00:00:01Z' }), true);
});
