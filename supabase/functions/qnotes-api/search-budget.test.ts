import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SEARCH_CANDIDATES, searchCandidateLimit } from './search-budget.ts';

test('sizes search candidates from the requested page and per-note diversity', () => {
  assert.equal(searchCandidateLimit(20, 2), 201);
  assert.equal(searchCandidateLimit(500, 10), MAX_SEARCH_CANDIDATES);
  assert.equal(searchCandidateLimit(500, 1), 1_000);
});

test('always leaves a lookahead row for the smallest page', () => {
  assert.equal(searchCandidateLimit(1, 1), 6);
});
