export const SYNTHETIC_EMBEDDING_MODE = 'synthetic-test-v1';

export type EmbeddingMode = 'provider' | typeof SYNTHETIC_EMBEDDING_MODE;

export function resolveEmbeddingMode(environment: { get(name: string): string | undefined }): EmbeddingMode {
  if (environment.get('QNOTES_FAKE_EMBEDDINGS') !== '1') return 'provider';
  if (environment.get('QNOTES_ENVIRONMENT') !== 'test' || environment.get('QNOTES_EMBEDDING_MODE') !== SYNTHETIC_EMBEDDING_MODE) {
    throw new Error('Synthetic embeddings require the explicit test environment and synthetic-test-v1 mode.');
  }
  return SYNTHETIC_EMBEDDING_MODE;
}

export function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 384 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('Embedding runtime returned an invalid vector.');
  }
  const magnitude = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Embedding runtime returned a zero-norm vector.');
  return value.map((item) => item / magnitude);
}
