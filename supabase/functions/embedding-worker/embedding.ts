async function digestBytes(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
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

export async function createEmbedding(value: string): Promise<number[]> {
  if (Deno.env.get('QNOTES_FAKE_EMBEDDINGS') === '1') return fakeEmbedding(value);
  const runtime = globalThis as unknown as { Supabase?: { ai?: { Session: new (model: string) => { run(input: string): Promise<unknown> } } } };
  const Session = runtime.Supabase?.ai?.Session;
  if (!Session) throw new Error('Supabase AI embedding runtime is unavailable.');
  const result = await new Session('gte-small').run(value);
  if (!Array.isArray(result) || result.length !== 384 || !result.every((item) => typeof item === 'number')) throw new Error('Embedding runtime returned an invalid vector.');
  const magnitude = Math.sqrt(result.reduce((sum, item) => sum + item * item, 0)) || 1;
  return result.map((item) => item / magnitude);
}
