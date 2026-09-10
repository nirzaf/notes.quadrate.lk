import assert from 'node:assert/strict';
import test from 'node:test';
import { boundQueryEmbedding, DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS, MAX_QUERY_EMBEDDING_TIMEOUT_MS, resolveQueryEmbeddingTimeout } from './query-embedding.ts';
import { isProviderEmbeddingTimeout } from '../embedding-worker/worker-budget.ts';

test('query embedding timeout configuration stays positive and bounded', () => {
  assert.equal(resolveQueryEmbeddingTimeout(undefined), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('not-a-number'), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('0'), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout(String(MAX_QUERY_EMBEDDING_TIMEOUT_MS + 1)), MAX_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('125'), 125);
});

test('never-resolving query embeddings are bounded for fallback', async () => {
  const pending = new Promise<never>(() => undefined);
  await assert.rejects(boundQueryEmbedding(pending, 5), (error: unknown) => isProviderEmbeddingTimeout(error));
});
