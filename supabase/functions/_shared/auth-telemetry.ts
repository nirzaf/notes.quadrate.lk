const LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

export function shouldUpdateLastUsedAt(lastUsedAt: string | null, now = Date.now()): boolean {
  if (lastUsedAt === null) return true;
  const parsed = Date.parse(lastUsedAt);
  return !Number.isFinite(parsed) || now - parsed >= LAST_USED_UPDATE_INTERVAL_MS;
}
