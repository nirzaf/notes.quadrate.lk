import type { SearchMode } from '@qnotes/shared';
import { toolResult, type ReadQNotesClient } from './common.js';

export async function searchNotesTool(client: ReadQNotesClient, args: { query: string; mode?: SearchMode; limit?: number }) {
  const response = await client.searchPost({
    query: args.query,
    mode: args.mode ?? 'auto',
    limit: args.limit ?? 8,
    maxPerNote: 2,
    filters: {},
  });
  return toolResult(response);
}
