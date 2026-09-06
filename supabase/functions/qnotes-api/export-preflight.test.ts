import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_EXPORT_ENTRIES, planWorkspaceExport } from './export-preflight.ts';

test('accepts a workspace plan below the configured limits', () => {
  const result = planWorkspaceExport(100, 200, 100, 3, 10_000);
  assert.equal(result.ok, true);
});

test('rejects a workspace plan before attachment downloads when estimated bytes are too large', () => {
  const result = planWorkspaceExport(9_000, 0, 100, 2, 9_500);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'too_large');
});

test('rejects a workspace plan with too many archive entries', () => {
  const result = planWorkspaceExport(0, 0, 0, MAX_EXPORT_ENTRIES + 1, 10_000_000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'too_many_entries');
});
