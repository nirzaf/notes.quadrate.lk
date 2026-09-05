import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbedding } from '../../supabase/functions/embedding-worker/embedding.ts';

test('rejects invalid embedding vectors before normalization', () => {
  assert.throws(() => normalizeEmbedding([]), /invalid vector/);
  assert.throws(() => normalizeEmbedding(Array.from({ length: 384 }, () => Number.NaN)), /invalid vector/);
  assert.throws(() => normalizeEmbedding(Array.from({ length: 384 }, () => Number.POSITIVE_INFINITY)), /invalid vector/);
  assert.throws(() => normalizeEmbedding(Array.from({ length: 384 }, () => 0)), /zero-norm vector/);
});

test('normalizes a finite non-zero embedding vector', () => {
  const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 3 : 0);
  const normalized = normalizeEmbedding(vector);
  assert.equal(normalized.length, 384);
  assert.equal(normalized[0], 1);
  assert.equal(normalized.slice(1).every((value) => value === 0), true);
});