export const SEARCH_RANKING_VERSION = 'v3-bounded-fusion';
export const MAX_SEARCH_CANDIDATES = 1_000;

export function searchCandidateLimit(limit: number, maxPerNote: number): number {
  return Math.min(MAX_SEARCH_CANDIDATES, Math.max(limit + 1, limit * Math.max(1, maxPerNote) * 5 + 1));
}
