import type { Context } from 'hono';
import { validateLimit, validateSearchMode, validateSearchQuery } from '@qnotes/shared';
import { createEmbedding } from '../embedding-worker/embedding.ts';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { searchResultFromRow, serviceClient } from '../_shared/database.ts';

export async function searchNotes(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const params = context.req.query();
  const query = validateSearchQuery(params.q);
  const mode = validateSearchMode(params.mode ?? 'keyword');
  const limit = validateLimit(params.limit, 50, 20);
  if (mode === 'keyword') {
    const result = await serviceClient.rpc('qnotes_keyword_search', { p_owner_id: auth.userId, p_query: query, p_limit: limit });
    if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Keyword search failed.');
    return context.json({ data: (Array.isArray(result.data) ? result.data : []).map((row) => searchResultFromRow(row as Record<string, unknown>)) });
  }
  let embedding: number[];
  try {
    embedding = await createEmbedding(query);
  } catch {
    throw new ApiError(503, 'SEMANTIC_SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable.');
  }
  const result = mode === 'semantic'
    ? await serviceClient.rpc('qnotes_semantic_search', { p_owner_id: auth.userId, p_embedding: embedding, p_limit: limit })
    : await serviceClient.rpc('qnotes_hybrid_search', { p_owner_id: auth.userId, p_query: query, p_embedding: embedding, p_limit: limit, p_rrf_k: 60 });
  if (result.error) throw new ApiError(503, 'SEMANTIC_SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable.');
  return context.json({ data: (Array.isArray(result.data) ? result.data : []).map((row) => searchResultFromRow(row as Record<string, unknown>)) });
}
