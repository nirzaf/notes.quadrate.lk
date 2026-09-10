import { boundProviderEmbedding, type ProviderEmbeddingTimeoutError } from '../embedding-worker/worker-budget.ts';

export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 500;
export const MAX_QUERY_EMBEDDING_TIMEOUT_MS = 5_000;

export function resolveQueryEmbeddingTimeout(value: string | undefined): number {
  const configured = Number(value ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS;
  return Math.min(configured, MAX_QUERY_EMBEDDING_TIMEOUT_MS);
}

export function boundQueryEmbedding<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return boundProviderEmbedding(promise, timeoutMs);
}

export type QueryEmbeddingTimeoutError = ProviderEmbeddingTimeoutError;
