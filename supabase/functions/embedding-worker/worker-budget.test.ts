import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundProviderEmbedding,
  canStartWork,
  createWorkerBudget,
  isProviderEmbeddingTimeout,
  MAX_BATCHES_PER_REQUEST,
  remainingWorkerBudgetMs,
  shouldStartBatch,
  WORKER_BATCH_SIZE,
  WORKER_DRAIN_BUDGET_MS,
  WORKER_VISIBILITY_LEASE_SECONDS,
} from './worker-budget.ts';

test('visibility lease exceeds the bounded drain budget', () => {
  assert.ok(WORKER_VISIBILITY_LEASE_SECONDS * 1000 > WORKER_DRAIN_BUDGET_MS);
});

test('batch policy permits at most four reads of 50 messages', () => {
  const budget = createWorkerBudget(1_000, 10_000);

  assert.equal(WORKER_BATCH_SIZE, 50);
  assert.equal(MAX_BATCHES_PER_REQUEST, 4);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => shouldStartBatch(index, budget, 1_001)),
    [true, true, true, true, false, false],
  );
});

test('work cannot start at or after the drain deadline', () => {
  const budget = createWorkerBudget(1_000, 100);

  assert.equal(canStartWork(budget, 1_099), true);
  assert.equal(remainingWorkerBudgetMs(budget, 1_099), 1);
  assert.equal(canStartWork(budget, 1_100), false);
  assert.equal(shouldStartBatch(0, budget, 1_100), false);
});

test('provider timeout is bounded and remains identifiable as retryable', async () => {
  const pendingProvider = new Promise<never>(() => undefined);

  await assert.rejects(
    boundProviderEmbedding(pendingProvider, 5),
    (error: unknown) => isProviderEmbeddingTimeout(error),
  );
});
