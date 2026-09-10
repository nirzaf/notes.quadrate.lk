import {
  EMBEDDING_INPUT_BYTE_BUDGET,
  EMBEDDING_INPUT_VERSION,
  embeddingInput as buildEmbeddingInput,
  embeddingInputByteLength,
  embeddingInputHash as hashEmbeddingInput,
} from '@qnotes/markdown';

export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_MODEL_VERSION = 'v2';
export { EMBEDDING_INPUT_BYTE_BUDGET, EMBEDDING_INPUT_VERSION };
export const SYNTHETIC_EMBEDDING_MODE = 'synthetic-test-v1';

export type EmbeddingMode = 'provider' | typeof SYNTHETIC_EMBEDDING_MODE;

export function resolveEmbeddingMode(environment: { get(name: string): string | undefined }): EmbeddingMode {
  if (environment.get('QNOTES_FAKE_EMBEDDINGS') !== '1') return 'provider';
  if (environment.get('QNOTES_ENVIRONMENT') !== 'test' || environment.get('QNOTES_EMBEDDING_MODE') !== SYNTHETIC_EMBEDDING_MODE) {
    throw new Error('Synthetic embeddings require the explicit test environment and synthetic-test-v1 mode.');
  }
  return SYNTHETIC_EMBEDDING_MODE;
}

interface EmbeddingSession {
  run(input: string): Promise<unknown>;
}

type SessionConstructor = new (model: string) => EmbeddingSession;

let cachedSession: EmbeddingSession | null = null;
let cachedSessionConstructor: SessionConstructor | null = null;

async function digestBytes(value: Uint8Array): Promise<Uint8Array> {
  const input = value.slice();
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer));
}

export async function fakeEmbedding(value: string): Promise<number[]> {
  const seed = new TextEncoder().encode(value);
  const bytes: number[] = [];
  let round = 0;
  while (bytes.length < 384) {
    const input = new Uint8Array(seed.length + 4);
    input.set(seed);
    new DataView(input.buffer).setUint32(seed.length, round, false);
    bytes.push(...await digestBytes(input));
    round += 1;
  }
  const vector = bytes.slice(0, 384).map((byte) => byte / 127.5 - 1);
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / magnitude);
}

export const embeddingInput = buildEmbeddingInput;

export const embeddingInputHash = hashEmbeddingInput;

export function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 384 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('Embedding runtime returned an invalid vector.');
  }
  const magnitude = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Embedding runtime returned a zero-norm vector.');
  return value.map((item) => item / magnitude);
}

function getSession(): EmbeddingSession {
  const runtime = globalThis as unknown as { Supabase?: { ai?: { Session?: SessionConstructor } } };
  const Session = runtime.Supabase?.ai?.Session;
  if (!Session) throw new Error('Supabase AI embedding runtime is unavailable.');
  if (!cachedSession || cachedSessionConstructor !== Session) {
    cachedSession = new Session(EMBEDDING_MODEL);
    cachedSessionConstructor = Session;
  }
  return cachedSession;
}

export async function createEmbedding(value: string): Promise<number[]> {
  if (embeddingInputByteLength(value) > EMBEDDING_INPUT_BYTE_BUDGET) {
    throw new Error(`Embedding input exceeds the conservative ${EMBEDDING_INPUT_BYTE_BUDGET}-byte provider budget.`);
  }
  if (resolveEmbeddingMode(Deno.env) === SYNTHETIC_EMBEDDING_MODE) return fakeEmbedding(value);
  const result = await getSession().run(value);
  return normalizeEmbedding(result);
}
