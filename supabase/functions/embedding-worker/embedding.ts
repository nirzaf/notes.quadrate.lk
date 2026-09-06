export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_MODEL_VERSION = 'v2';

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

export function embeddingInput(document: { content: string; sourceTitle?: string | null; headingPath?: string | null }): string {
  return [document.sourceTitle, document.headingPath, document.content]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .join('\n\n');
}

export async function embeddingInputHash(document: { content: string; sourceTitle?: string | null; headingPath?: string | null }): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(embeddingInput(document)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
  if (Deno.env.get('QNOTES_FAKE_EMBEDDINGS') === '1') return fakeEmbedding(value);
  const result = await getSession().run(value);
  return normalizeEmbedding(result);
}
