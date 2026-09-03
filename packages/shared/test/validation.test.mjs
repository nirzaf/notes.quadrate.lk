import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoSearchMode, validateSearchRequest } from '../dist/validation.js';

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
    },
    minimumConfidence: 0.45,
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
    },
    minimumConfidence: 0.45,
    cursor: 'cursor-1',
  });
});
