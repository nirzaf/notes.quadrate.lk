import type { Context } from 'hono';
import { QNotesValidationError, resolveAutoSearchMode, validateSearchRequest, validateLimit, validateSearchMode, validateSearchQuery } from '@qnotes/shared';
import type { ResolvedSearchMode, SearchFilters, SearchIndexMetadata, SearchRequest, SearchResponseMetadata, SearchResult } from '@qnotes/shared';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION, createEmbedding } from '../embedding-worker/embedding.ts';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient, searchResultFromRow, serviceClient } from '../_shared/database.ts';

const QUERY_EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000;
const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const queryEmbeddingCache = new Map<string, { expiresAt: number; value: Promise<number[]> }>();

function cachedQueryEmbedding(query: string): Promise<number[]> {
  const key = query.trim().toLowerCase();
  const now = Date.now();
  const existing = queryEmbeddingCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  if (existing) queryEmbeddingCache.delete(key);
  const value = createEmbedding(query).catch((error: unknown) => {
    const current = queryEmbeddingCache.get(key);
    if (current?.value === value) queryEmbeddingCache.delete(key);
    throw error;
  });
  queryEmbeddingCache.set(key, { expiresAt: now + QUERY_EMBEDDING_CACHE_TTL_MS, value });
  while (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    queryEmbeddingCache.delete(oldest);
  }
  return queryEmbeddingCache.get(key)?.value ?? value;
}

function elapsedMilliseconds(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

async function keywordSearch(userId: string, query: string, limit: number): Promise<SearchResult[]> {
  const result = await serviceClient.rpc('qnotes_keyword_search', { p_owner_id: userId, p_query: query, p_limit: limit });
  if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Keyword search failed.');
  return (Array.isArray(result.data) ? result.data : []).map((row) => searchResultFromRow(row as Record<string, unknown>));
}

interface SearchNoteRow {
  id: string;
  version: number;
  tags: string[];
  notebook_id: string | null;
  updated_at: string;
}

async function noteMetadata(userId: string, noteIds: string[]): Promise<Map<string, SearchNoteRow>> {
  if (!noteIds.length) return new Map();
  const { data, error } = await appDbClient.from('notes').select('id, version, tags, notebook_id, updated_at').eq('owner_id', userId).in('id', noteIds).is('deleted_at', null);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Search metadata lookup failed.');
  const rows = Array.isArray(data) ? data as unknown as SearchNoteRow[] : [];
  return new Map(rows.map((row) => [row.id, row]));
}

async function indexMetadata(userId: string): Promise<SearchIndexMetadata> {
  const [pendingCount, failedCount, oldestPending] = await Promise.all([
    appDbClient.from('search_documents').select('id', { count: 'exact', head: true }).eq('owner_id', userId).eq('embedding_status', 'pending'),
    appDbClient.from('search_documents').select('id', { count: 'exact', head: true }).eq('owner_id', userId).eq('embedding_status', 'failed'),
    appDbClient.from('search_documents').select('created_at').eq('owner_id', userId).eq('embedding_status', 'pending').order('created_at', { ascending: true }).limit(1),
  ]);
  if (pendingCount.error || failedCount.error || oldestPending.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Search freshness lookup failed.');
  const oldestCreatedAt = Array.isArray(oldestPending.data) && oldestPending.data[0] && typeof oldestPending.data[0].created_at === 'string' ? Date.parse(oldestPending.data[0].created_at) : NaN;
  return {
    model: `${EMBEDDING_MODEL}:${EMBEDDING_MODEL_VERSION}`,
    pendingDocuments: pendingCount.count ?? 0,
    failedDocuments: failedCount.count ?? 0,
    oldestPendingAgeSeconds: Number.isFinite(oldestCreatedAt) ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1000)) : null,
    fresh: (pendingCount.count ?? 0) === 0 && (failedCount.count ?? 0) === 0,
  };
}

function normalizeResult(item: SearchResult, note: SearchNoteRow | undefined, minimumScore: number, maximumScore: number): SearchResult {
  const matchReasons = [
    item.keywordRank !== null ? 'keyword_match' : null,
    item.semanticRank !== null ? 'semantic_match' : null,
    item.headingPath ? 'heading_match' : null,
    item.copyable && item.language ? 'code_language_match' : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    ...item,
    documentId: item.id,
    ...(note ? { noteVersion: note.version, tags: note.tags, notebookId: note.notebook_id, updatedAt: note.updated_at } : { tags: [], notebookId: null }),
    uri: `qnotes://notes/${item.noteId}/documents/${item.id}`,
    matchReasons,
    scores: {
      hybrid: maximumScore > minimumScore ? (item.score - minimumScore) / (maximumScore - minimumScore) : 1,
      keywordRank: item.keywordRank,
      semanticRank: item.semanticRank,
    },
  };
}

function filterResults(items: SearchResult[], notes: Map<string, SearchNoteRow>, filters: SearchFilters, maxPerNote: number, minimumConfidence?: number): SearchResult[] {
  const scores = items.map((item) => item.score);
  const minimumScore = scores.length ? Math.min(...scores) : 0;
  const maximumScore = scores.length ? Math.max(...scores) : 0;
  const candidates = items
    .map((item) => normalizeResult(item, notes.get(item.noteId), minimumScore, maximumScore))
    .filter((item) => {
      const note = notes.get(item.noteId);
      if (!note) return false;
      if (filters.notebookIds?.length && !filters.notebookIds.includes(note.notebook_id ?? '')) return false;
      if (filters.tags?.length && !filters.tags.every((tag) => note.tags.includes(tag))) return false;
      if (filters.sourceTypes?.length && !filters.sourceTypes.includes(item.sourceType)) return false;
      if (filters.languages?.length && !filters.languages.includes((item.language ?? '').toLowerCase())) return false;
      if (filters.updatedAfter && Date.parse(note.updated_at) < Date.parse(filters.updatedAfter)) return false;
      if (minimumConfidence !== undefined && (item.scores?.hybrid ?? 0) < minimumConfidence) return false;
      return true;
    });
  const counts = new Map<string, number>();
  return candidates.filter((item) => {
    const count = counts.get(item.noteId) ?? 0;
    if (count >= maxPerNote) return false;
    counts.set(item.noteId, count + 1);
    return true;
  });
}

function pageResults(items: SearchResult[], request: SearchRequest): { items: SearchResult[]; nextCursor: string | null } {
  let offset = 0;
  if (request.cursor !== undefined) {
    const match = /^offset:(\d+)$/.exec(request.cursor);
    if (!match) throw new ApiError(422, 'VALIDATION_ERROR', 'cursor must be an opaque search cursor.');
    offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(422, 'VALIDATION_ERROR', 'cursor is invalid.');
  }
  const page = items.slice(offset, offset + request.limit);
  const nextOffset = offset + page.length;
  return { items: page, nextCursor: nextOffset < items.length ? `offset:${nextOffset}` : null };
}

function searchResponse(
  context: Context,
  items: SearchResult[],
  metadata: Omit<SearchResponseMetadata, 'timing'> & { started: number; embeddingMs: number; retrievalStarted: number },
  index: SearchIndexMetadata,
  nextCursor: string | null,
  degradedReason?: SearchResponseMetadata['degradedReason'],
): Response {
  const responseMetadata: SearchResponseMetadata = {
    queryId: metadata.queryId,
    modeUsed: metadata.modeUsed,
    degraded: metadata.degraded,
    ...(degradedReason ? { degradedReason } : {}),
    timing: {
      embeddingMs: metadata.embeddingMs,
      retrievalMs: elapsedMilliseconds(metadata.retrievalStarted),
      totalMs: elapsedMilliseconds(metadata.started),
    },
  };
  return context.json({ data: { items, ...responseMetadata, index, nextCursor } });
}

function validationError(error: unknown): never {
  if (error instanceof QNotesValidationError) throw new ApiError(422, 'VALIDATION_ERROR', error.message, error.details);
  throw error;
}

async function requestFromContext(context: Context): Promise<SearchRequest> {
  if (context.req.method === 'POST') {
    try {
      return validateSearchRequest(await context.req.json());
    } catch (error: unknown) {
      return validationError(error);
    }
  }
  try {
    const params = context.req.query();
    const query = validateSearchQuery(params.q);
    const requestedMode = validateSearchMode(params.mode ?? 'auto');
    return {
      query,
      mode: requestedMode,
      limit: validateLimit(params.limit, 50, 20),
      maxPerNote: 2,
      filters: {},
    };
  } catch (error: unknown) {
    return validationError(error);
  }
}

export async function searchNotes(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const started = performance.now();
  const request = await requestFromContext(context);
  const mode: ResolvedSearchMode = request.mode === 'auto' ? resolveAutoSearchMode(request.query) : request.mode;
  const candidateLimit = context.req.method === 'POST' ? 50 : request.limit;
  const queryId = crypto.randomUUID();
  const embeddingStarted = performance.now();
  let embedding: number[] | undefined;
  if (mode !== 'keyword') {
    try {
      embedding = await cachedQueryEmbedding(request.query);
    } catch {
      const retrievalStarted = performance.now();
      const fallbackItems = await keywordSearch(auth.userId, request.query, candidateLimit);
      const fallbackNotes = await noteMetadata(auth.userId, [...new Set(fallbackItems.map((item) => item.noteId))]);
      const page = pageResults(filterResults(fallbackItems, fallbackNotes, request.filters, request.maxPerNote, request.minimumConfidence), request);
      return searchResponse(context, page.items, { queryId, modeUsed: 'keyword', degraded: true, started, embeddingMs: elapsedMilliseconds(embeddingStarted), retrievalStarted }, await indexMetadata(auth.userId), page.nextCursor, 'QUERY_EMBEDDING_UNAVAILABLE');
    }
  }

  const retrievalStarted = performance.now();
  let rawItems: SearchResult[];
  let degradedReason: SearchResponseMetadata['degradedReason'];
  try {
    if (mode === 'keyword') {
      rawItems = await keywordSearch(auth.userId, request.query, candidateLimit);
    } else {
      const result = mode === 'semantic'
        ? await serviceClient.rpc('qnotes_semantic_search', { p_owner_id: auth.userId, p_query: request.query, p_embedding: embedding!, p_limit: candidateLimit })
        : await serviceClient.rpc('qnotes_hybrid_search', { p_owner_id: auth.userId, p_query: request.query, p_embedding: embedding!, p_limit: candidateLimit, p_rrf_k: 60 });
      if (result.error) throw new ApiError(503, 'SEMANTIC_SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable.');
      rawItems = (Array.isArray(result.data) ? result.data : []).map((row) => searchResultFromRow(row as Record<string, unknown>));
    }
  } catch (error: unknown) {
    if (mode === 'keyword') throw error;
    const fallbackItems = await keywordSearch(auth.userId, request.query, candidateLimit);
    const fallbackNotes = await noteMetadata(auth.userId, [...new Set(fallbackItems.map((item) => item.noteId))]);
    const page = pageResults(filterResults(fallbackItems, fallbackNotes, request.filters, request.maxPerNote, request.minimumConfidence), request);
    return searchResponse(context, page.items, { queryId, modeUsed: 'keyword', degraded: true, started, embeddingMs: elapsedMilliseconds(embeddingStarted), retrievalStarted }, await indexMetadata(auth.userId), page.nextCursor, 'SEMANTIC_SEARCH_UNAVAILABLE');
  }
  const notes = await noteMetadata(auth.userId, [...new Set(rawItems.map((item) => item.noteId))]);
  const page = pageResults(filterResults(rawItems, notes, request.filters, request.maxPerNote, request.minimumConfidence), request);
  return searchResponse(context, page.items, { queryId, modeUsed: mode, degraded: Boolean(degradedReason), started, embeddingMs: mode === 'keyword' ? 0 : elapsedMilliseconds(embeddingStarted), retrievalStarted }, await indexMetadata(auth.userId), page.nextCursor, degradedReason);
}
