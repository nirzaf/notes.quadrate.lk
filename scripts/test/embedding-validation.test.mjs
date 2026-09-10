import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbedding, resolveEmbeddingMode, SYNTHETIC_EMBEDDING_MODE } from '../../supabase/functions/embedding-worker/policy.ts';

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

test('synthetic embeddings require an explicit test-only identity', () => {
  assert.equal(resolveEmbeddingMode(new Map()), 'provider');
  assert.throws(() => resolveEmbeddingMode(new Map([
    ['QNOTES_FAKE_EMBEDDINGS', '1'],
  ])), /explicit test environment/);
  assert.equal(resolveEmbeddingMode(new Map([
    ['QNOTES_FAKE_EMBEDDINGS', '1'],
    ['QNOTES_ENVIRONMENT', 'test'],
    ['QNOTES_EMBEDDING_MODE', SYNTHETIC_EMBEDDING_MODE],
  ])), SYNTHETIC_EMBEDDING_MODE);
});
