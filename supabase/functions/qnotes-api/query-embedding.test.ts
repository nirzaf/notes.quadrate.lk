import assert from 'node:assert/strict';
import test from 'node:test';
import { boundQueryEmbedding, DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS, forgetQueryEmbedding, MAX_QUERY_EMBEDDING_TIMEOUT_MS, resolveQueryEmbeddingTimeout, type QueryEmbeddingCacheEntry } from './query-embedding.ts';
import { isProviderEmbeddingTimeout } from '../embedding-worker/worker-budget.ts';
import { measureNoteMetadata } from './search-timing.ts';

test('query embedding timeout configuration stays positive and bounded', () => {
  assert.equal(resolveQueryEmbeddingTimeout(undefined), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('not-a-number'), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('0'), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout(String(MAX_QUERY_EMBEDDING_TIMEOUT_MS + 1)), DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  assert.equal(resolveQueryEmbeddingTimeout('125'), 125);
});

test('never-resolving query embeddings are bounded for fallback', async () => {
  const pending = new Promise<never>(() => undefined);
  await assert.rejects(boundQueryEmbedding(pending, 5), (error: unknown) => isProviderEmbeddingTimeout(error));
});

test('timed-out query embeddings cannot forget a replacement cache entry', () => {
  const timedOut = Promise.resolve([1]);
  const replacement = Promise.resolve([2]);
  const cache = new Map<string, QueryEmbeddingCacheEntry>([['key', { expiresAt: Date.now() + 1_000, value: replacement }]]);

  forgetQueryEmbedding(cache, 'key', timedOut);
  assert.equal(cache.get('key')?.value, replacement);

  forgetQueryEmbedding(cache, 'key', replacement);
  assert.equal(cache.has('key'), false);
});

test('note metadata timing stops before concurrent freshness work finishes', async () => {
  let now = 0;
  let releaseMetadata!: () => void;
  let releaseFreshness!: () => void;
  const metadata = measureNoteMetadata(() => new Promise<string>((resolve) => {
    releaseMetadata = () => {
      now = 10;
      resolve('notes');
    };
  }), () => now);
  const freshness = new Promise<string>((resolve) => {
    releaseFreshness = () => {
      now = 100;
      resolve('fresh');
    };
  });

  const combined = Promise.all([metadata, freshness]);
  releaseMetadata();
  assert.deepEqual(await metadata, { value: 'notes', metadataMs: 10 });
  releaseFreshness();
  await combined;
});
