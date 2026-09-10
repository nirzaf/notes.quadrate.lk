import {
  EMBEDDING_INPUT_BYTE_BUDGET,
  EMBEDDING_INPUT_VERSION,
  embeddingInput as buildEmbeddingInput,
  embeddingInputByteLength,
  embeddingInputHash as hashEmbeddingInput,
} from '@qnotes/markdown';
import { normalizeEmbedding, resolveEmbeddingMode, SYNTHETIC_EMBEDDING_MODE } from './policy.ts';

export { normalizeEmbedding, resolveEmbeddingMode, SYNTHETIC_EMBEDDING_MODE } from './policy.ts';

export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_MODEL_VERSION = 'v2';
export { EMBEDDING_INPUT_BYTE_BUDGET, EMBEDDING_INPUT_VERSION };

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
