import type { SearchFilters, SearchMode } from '@qnotes/shared';
import { toolResult, type ReadQNotesClient } from './common.js';

export async function searchNotesTool(client: ReadQNotesClient, args: { query: string; mode?: SearchMode; limit?: number; cursor?: string; filters?: SearchFilters }) {
  const response = await client.searchPost({
    query: args.query,
    mode: args.mode ?? 'auto',
    limit: args.limit ?? 8,
    maxPerNote: 2,
    filters: args.filters ?? {},
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
  });
  return toolResult(response);
}
