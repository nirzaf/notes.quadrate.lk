export async function measureNoteMetadata<T>(load: () => Promise<T>, now: () => number = () => performance.now()): Promise<{ value: T; metadataMs: number }> {
  const started = now();
  const value = await load();
  return { value, metadataMs: Math.max(0, Math.round(now() - started)) };
}
