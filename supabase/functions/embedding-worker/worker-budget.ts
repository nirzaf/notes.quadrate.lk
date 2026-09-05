/**
 * The embedding worker is invoked every 30 seconds, so one invocation must
 * drain a finite amount of work without holding messages past their lease.
 * Four reads of 50 messages preserve the existing queue pressure, while the
 * existing concurrency of three avoids compensating for slow providers by
 * increasing parallelism. A 90-second drain budget leaves 30 seconds of
 * margin in the current 120-second visibility lease after this invocation
 * has stopped starting work.
 */
export const WORKER_BATCH_SIZE = 50;
export const MAX_BATCHES_PER_REQUEST = 4;
export const WORKER_VISIBILITY_LEASE_SECONDS = 120;
export const WORKER_DRAIN_BUDGET_MS = 90_000;

/**
 * A provider call gets at most ten seconds, or the time remaining in the
 * drain window when that is shorter. A timeout is deliberately retryable: it
 * must not turn a slow provider into a permanent failed/archive outcome.
 */
export const PROVIDER_EMBEDDING_TIMEOUT_MS = 10_000;

export interface WorkerBudget {
  readonly drainDeadlineMs: number;
}

export function createWorkerBudget(startedAtMs: number, drainBudgetMs = WORKER_DRAIN_BUDGET_MS): WorkerBudget {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(drainBudgetMs) || drainBudgetMs <= 0) {
    throw new RangeError('Worker budget requires a finite positive duration.');
  }
  const drainDeadlineMs = startedAtMs + drainBudgetMs;
  if (!Number.isFinite(drainDeadlineMs)) throw new RangeError('Worker budget deadline is out of range.');
  return { drainDeadlineMs };
}

export function canStartWork(budget: WorkerBudget, nowMs: number): boolean {
  return Number.isFinite(nowMs) && nowMs < budget.drainDeadlineMs;
}

export function shouldStartBatch(batchIndex: number, budget: WorkerBudget, nowMs: number): boolean {
  return Number.isInteger(batchIndex)
    && batchIndex >= 0
    && batchIndex < MAX_BATCHES_PER_REQUEST
    && canStartWork(budget, nowMs);
}

export function remainingWorkerBudgetMs(budget: WorkerBudget, nowMs: number): number {
  return Math.max(0, budget.drainDeadlineMs - nowMs);
}

export class ProviderEmbeddingTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Embedding provider exceeded its ${timeoutMs}ms budget.`);
    this.name = 'ProviderEmbeddingTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function isProviderEmbeddingTimeout(error: unknown): error is ProviderEmbeddingTimeoutError {
  return error instanceof ProviderEmbeddingTimeoutError;
}

export async function boundProviderEmbedding<T>(providerPromise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Provider timeout must be positive.');

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new ProviderEmbeddingTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([providerPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
