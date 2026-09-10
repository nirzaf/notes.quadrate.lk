import type { Context } from 'hono';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, QNotesValidationError, resolveAutoSearchMode, validateSearchRequest, validateLimit, validateSearchMode, validateSearchQuery } from '@qnotes/shared';
import type { ResolvedSearchMode, SearchFilters, SearchIndexMetadata, SearchRequest, SearchResponseMetadata, SearchResult } from '@qnotes/shared';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION, boundEmbeddingInput, createEmbedding, resolveEmbeddingMode } from '../embedding-worker/embedding.ts';
import { boundQueryEmbedding, forgetQueryEmbedding, resolveQueryEmbeddingTimeout, type QueryEmbeddingCacheEntry } from './query-embedding.ts';
import { measureNoteMetadata } from './search-timing.ts';
import { authFromContext, requireScope, type AuthContext } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient, decodeSearchCursor, encodeSearchCursor, requestHash, searchResultFromRow, serviceClient } from '../_shared/database.ts';
import { enforceRequestBudget } from '../_shared/request-limits.ts';
import { applyNotebookAccess, authPolicyKey, isAccountWide, scopedSearchPlan } from '../_shared/notebook-access.ts';
import { SEARCH_RANKING_VERSION, searchCandidateLimit } from './search-budget.ts';

const QUERY_EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000;
const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const MAX_OUTSTANDING_QUERY_EMBEDDINGS = 8;
const queryEmbeddingCache = new Map<string, QueryEmbeddingCacheEntry>();
let outstandingQueryEmbeddings = 0;

function queryEmbeddingKey(query: string): string {
  return `${EMBEDDING_MODEL}:${EMBEDDING_MODEL_VERSION}:${query.trim()}`;
}

function cachedQueryEmbedding(query: string): Promise<number[]> {
  const key = queryEmbeddingKey(query);
  const now = Date.now();
  const existing = queryEmbeddingCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  if (existing) queryEmbeddingCache.delete(key);
  if (outstandingQueryEmbeddings >= MAX_OUTSTANDING_QUERY_EMBEDDINGS) return Promise.reject(new Error('QUERY_EMBEDDING_CONCURRENCY_LIMIT'));
  outstandingQueryEmbeddings += 1;
  const value = createEmbedding(boundEmbeddingInput(query)).then(
    (result) => {
      outstandingQueryEmbeddings -= 1;
      return result;
    },
    (error: unknown) => {
      outstandingQueryEmbeddings -= 1;
      const current = queryEmbeddingCache.get(key);
      if (current?.value === value) queryEmbeddingCache.delete(key);
      throw error;
    },
  );
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

async function keywordSearch(auth: AuthContext, query: string, limit: number, filters: SearchFilters, offset: number, maxPerNote: number): Promise<SearchResult[]> {
  const plan = scopedSearchPlan(auth, filters);
  if (plan.empty) return [];
  const result = await serviceClient.rpc(isAccountWide(auth) ? 'qnotes_keyword_search' : 'qnotes_keyword_search_scoped', {
    p_owner_id: auth.userId,
    p_query: query,
    p_limit: limit,
    p_filters: isAccountWide(auth) ? filters : plan.filters,
    p_offset: offset,
    p_max_per_note: maxPerNote,
    ...(isAccountWide(auth) ? {} : { p_notebook_ids: plan.notebookIds, p_allow_unfiled: plan.allowUnfiled }),
  });
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

async function noteMetadata(auth: AuthContext, noteIds: string[]): Promise<Map<string, SearchNoteRow>> {
  if (!noteIds.length) return new Map();
  let query = appDbClient.from('notes').select('id, version, tags, notebook_id, updated_at').eq('owner_id', auth.userId).in('id', noteIds).is('deleted_at', null);
  query = applyNotebookAccess(query, auth);
  const { data, error } = await query;
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Search metadata lookup failed.');
  const rows = Array.isArray(data) ? data as unknown as SearchNoteRow[] : [];
  return new Map(rows.map((row) => [row.id, row]));
}

async function indexMetadata(auth: AuthContext): Promise<SearchIndexMetadata> {
  const freshness = await serviceClient.rpc(isAccountWide(auth) ? 'qnotes_search_freshness' : 'qnotes_search_freshness_scoped', {
    p_owner_id: auth.userId,
    ...(isAccountWide(auth) ? {} : { p_notebook_ids: auth.notebookIds, p_allow_unfiled: auth.allowUnfiled }),
  });
  if (freshness.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Search freshness lookup failed.');
  const row = Array.isArray(freshness.data) ? freshness.data[0] as Record<string, unknown> | undefined : freshness.data as Record<string, unknown> | null;
  const pendingDocuments = Number(row?.pending_documents ?? 0);
  const failedDocuments = Number(row?.failed_documents ?? 0);
  const oldestQueuedAt = typeof row?.oldest_queued_at === 'string' ? Date.parse(row.oldest_queued_at) : NaN;
  return {
    model: `${EMBEDDING_MODEL}:${EMBEDDING_MODEL_VERSION}`,
    pendingDocuments,
    failedDocuments,
    oldestPendingAgeSeconds: Number.isFinite(oldestQueuedAt) ? Math.max(0, Math.floor((Date.now() - oldestQueuedAt) / 1000)) : null,
    fresh: pendingDocuments === 0 && failedDocuments === 0,
    freshness: pendingDocuments === 0 && failedDocuments === 0 ? 'fresh' : 'stale',
  };
}

function unknownIndexMetadata(): SearchIndexMetadata {
  return {
    model: `${EMBEDDING_MODEL}:${EMBEDDING_MODEL_VERSION}`,
    pendingDocuments: 0,
    failedDocuments: 0,
    oldestPendingAgeSeconds: null,
    fresh: false,
    freshness: 'unknown',
  };
}

async function measuredIndexMetadata(auth: AuthContext): Promise<{ index: SearchIndexMetadata; freshnessMs: number }> {
  const started = performance.now();
  try {
    return { index: await indexMetadata(auth), freshnessMs: elapsedMilliseconds(started) };
  } catch {
    return { index: unknownIndexMetadata(), freshnessMs: elapsedMilliseconds(started) };
  }
}

function normalizeResult(item: SearchResult, note: SearchNoteRow | undefined, query: string, minimumScore: number, maximumScore: number): SearchResult {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const normalizedHeading = item.headingPath?.toLocaleLowerCase() ?? '';
  const normalizedLanguage = item.language?.toLocaleLowerCase() ?? '';
  const matchReasons = [
    item.keywordRank !== null ? 'keyword_match' : null,
    item.semanticRank !== null ? 'semantic_match' : null,
    normalizedHeading.includes(normalizedQuery) ? 'heading_match' : null,
    item.copyable && normalizedLanguage && normalizedQuery.includes(normalizedLanguage) ? 'code_language_match' : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    ...item,
    documentId: item.id,
    ...(note ? { noteVersion: note.version, tags: note.tags, notebookId: note.notebook_id, updatedAt: note.updated_at } : { tags: [], notebookId: null }),
    uri: `qnotes://notes/${item.noteId}/documents/${item.id}`,
    matchReasons,
    scores: {
      // Relative score is deliberately not described as a probability.
      hybrid: maximumScore > minimumScore ? (item.score - minimumScore) / (maximumScore - minimumScore) : 1,
      keywordRank: item.keywordRank,
      semanticRank: item.semanticRank,
    },
  };
}

function requestFingerprint(auth: AuthContext, request: SearchRequest, resolvedMode: ResolvedSearchMode, embeddingMode: string): Promise<string> {
  return requestHash({
    principal: authPolicyKey(auth),
    query: request.query,
    mode: resolvedMode,
    rankingVersion: SEARCH_RANKING_VERSION,
    embeddingMode,
    filters: request.filters,
    maxPerNote: request.maxPerNote,
    minimumRelativeScore: request.minimumRelativeScore,
  });
}

function cursorOffset(request: SearchRequest, fingerprint: string): number {
  if (!request.cursor) return 0;
  const cursor = decodeSearchCursor(request.cursor);
  if (cursor.fingerprint !== fingerprint) throw new ApiError(422, 'VALIDATION_ERROR', 'cursor does not belong to this search request.');
  return cursor.offset;
}

function pageResults(items: SearchResult[], request: SearchRequest, fingerprint: string, offset: number, notes: Map<string, SearchNoteRow>): { items: SearchResult[]; nextCursor: string | null } {
  const consumedRawItems = items.slice(0, request.limit);
  const scores = consumedRawItems.map((item) => item.score);
  const minimumScore = scores.length ? Math.min(...scores) : 0;
  const maximumScore = scores.length ? Math.max(...scores) : 0;
  const normalized = consumedRawItems
    .map((item) => normalizeResult(item, notes.get(item.noteId), request.query, minimumScore, maximumScore))
    .filter((item) => request.minimumRelativeScore === undefined || (item.scores?.hybrid ?? 0) >= request.minimumRelativeScore);
  const page = normalized.slice(0, request.limit);
  const hasMore = items.length > request.limit;
  const nextOffset = offset + consumedRawItems.length;
  return { items: page, nextCursor: hasMore ? encodeSearchCursor({ fingerprint, offset: nextOffset }) : null };
}

function searchResponse(
  context: Context,
  items: SearchResult[],
  metadata: Omit<SearchResponseMetadata, 'timing'> & { started: number; embeddingMs: number; retrievalMs: number; metadataMs: number; freshnessMs: number },
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
      retrievalMs: metadata.retrievalMs,
      totalMs: elapsedMilliseconds(metadata.started),
      metadataMs: metadata.metadataMs,
      freshnessMs: metadata.freshnessMs,
    },
  };
  const firstPayload = { data: { items, ...responseMetadata, index, nextCursor } };
  const serializationStarted = performance.now();
  JSON.stringify(firstPayload);
  const serializationMs = elapsedMilliseconds(serializationStarted);
  const payload = {
    data: {
      items,
      ...responseMetadata,
      timing: { ...responseMetadata.timing, serializationMs },
      index,
      nextCursor,
    },
  };
  return context.newResponse(JSON.stringify(payload), 200, { 'Content-Type': 'application/json; charset=UTF-8' });
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
      limit: validateLimit(params.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
      maxPerNote: 2,
      filters: {},
      ...(params.cursor ? { cursor: params.cursor } : {}),
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
  if (mode !== 'keyword') {
    await enforceRequestBudget('embedding', `user:${auth.userId}`, Math.max(1, Math.ceil(request.limit / 100)));
    context.set('limitDecision', 'embedding-allowed');
  }
  const embeddingMode = resolveEmbeddingMode(Deno.env);
  const fingerprint = await requestFingerprint(auth, request, mode, embeddingMode);
  const offset = cursorOffset(request, fingerprint);
  const retrievalLimit = searchCandidateLimit(request.limit, request.maxPerNote);
  const queryId = crypto.randomUUID();
  const embeddingStarted = performance.now();
  let embeddingMs = 0;
  let embedding: number[] | undefined;
  const searchFilters = { ...request.filters, embeddingMode };
  if (mode !== 'keyword') {
    const queryEmbedding = cachedQueryEmbedding(request.query);
    try {
      embedding = await boundQueryEmbedding(queryEmbedding, resolveQueryEmbeddingTimeout(Deno.env.get('QNOTES_QUERY_EMBEDDING_TIMEOUT_MS')));
      embeddingMs = elapsedMilliseconds(embeddingStarted);
    } catch {
      forgetQueryEmbedding(queryEmbeddingCache, queryEmbeddingKey(request.query), queryEmbedding);
      embeddingMs = elapsedMilliseconds(embeddingStarted);
      const retrievalStarted = performance.now();
      const fallbackItems = await keywordSearch(auth, request.query, retrievalLimit, searchFilters, offset, request.maxPerNote);
      const retrievalMs = elapsedMilliseconds(retrievalStarted);
      const [fallbackNoteMetadata, freshness] = await Promise.all([
        measureNoteMetadata(() => noteMetadata(auth, [...new Set(fallbackItems.slice(0, request.limit).map((item) => item.noteId))])),
        measuredIndexMetadata(auth),
      ]);
      const page = pageResults(fallbackItems, request, fingerprint, offset, fallbackNoteMetadata.value);
      // Degraded pages are deliberately not cursor-paginated: a later request
      // must not silently switch from the requested semantic/hybrid ranking.
      return searchResponse(context, page.items, { queryId, modeUsed: 'keyword', degraded: true, started, embeddingMs, retrievalMs, metadataMs: fallbackNoteMetadata.metadataMs, freshnessMs: freshness.freshnessMs }, freshness.index, null, 'QUERY_EMBEDDING_UNAVAILABLE');
    }
  }

  const retrievalStarted = performance.now();
  let retrievalMs = 0;
  let rawItems: SearchResult[];
  try {
    if (mode === 'keyword') {
      rawItems = await keywordSearch(auth, request.query, retrievalLimit, searchFilters, offset, request.maxPerNote);
    } else {
      const plan = scopedSearchPlan(auth, request.filters);
      if (plan.empty) {
        rawItems = [];
      } else {
        const result = mode === 'semantic'
          ? await serviceClient.rpc(isAccountWide(auth) ? 'qnotes_semantic_search' : 'qnotes_semantic_search_scoped', { p_owner_id: auth.userId, p_query: request.query, p_embedding: embedding!, p_limit: retrievalLimit, p_filters: isAccountWide(auth) ? searchFilters : { ...plan.filters, embeddingMode }, p_offset: offset, p_max_per_note: request.maxPerNote, ...(isAccountWide(auth) ? {} : { p_notebook_ids: plan.notebookIds, p_allow_unfiled: plan.allowUnfiled }) })
          : await serviceClient.rpc(isAccountWide(auth) ? 'qnotes_hybrid_search' : 'qnotes_hybrid_search_scoped', { p_owner_id: auth.userId, p_query: request.query, p_embedding: embedding!, p_limit: retrievalLimit, p_rrf_k: 60, p_filters: isAccountWide(auth) ? searchFilters : { ...plan.filters, embeddingMode }, p_offset: offset, p_max_per_note: request.maxPerNote, ...(isAccountWide(auth) ? {} : { p_notebook_ids: plan.notebookIds, p_allow_unfiled: plan.allowUnfiled }) });
        if (result.error) throw new ApiError(503, 'SEMANTIC_SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable.');
        rawItems = (Array.isArray(result.data) ? result.data : []).map((row) => searchResultFromRow(row as Record<string, unknown>));
      }
    }
    retrievalMs = elapsedMilliseconds(retrievalStarted);
  } catch (error: unknown) {
    if (mode === 'keyword') throw error;
    const fallbackItems = await keywordSearch(auth, request.query, retrievalLimit, searchFilters, offset, request.maxPerNote);
    retrievalMs = elapsedMilliseconds(retrievalStarted);
    const [fallbackNoteMetadata, freshness] = await Promise.all([
      measureNoteMetadata(() => noteMetadata(auth, [...new Set(fallbackItems.slice(0, request.limit).map((item) => item.noteId))])),
      measuredIndexMetadata(auth),
    ]);
    const page = pageResults(fallbackItems, request, fingerprint, offset, fallbackNoteMetadata.value);
    const degradedReason: SearchResponseMetadata['degradedReason'] = error instanceof ApiError && (error.code === 'SEMANTIC_SEARCH_UNAVAILABLE' || error.code === 'QUERY_EMBEDDING_UNAVAILABLE')
      ? error.code
      : 'SEMANTIC_SEARCH_UNAVAILABLE';
    // Degraded pages are deliberately not cursor-paginated: a later request
    // must not silently switch from the requested semantic/hybrid ranking.
    return searchResponse(context, page.items, { queryId, modeUsed: 'keyword', degraded: true, started, embeddingMs, retrievalMs, metadataMs: fallbackNoteMetadata.metadataMs, freshnessMs: freshness.freshnessMs }, freshness.index, null, degradedReason);
  }
  const [noteMetadataResult, freshness] = await Promise.all([
    measureNoteMetadata(() => noteMetadata(auth, [...new Set(rawItems.slice(0, request.limit).map((item) => item.noteId))])),
    measuredIndexMetadata(auth),
  ]);
  const page = pageResults(rawItems, request, fingerprint, offset, noteMetadataResult.value);
  return searchResponse(context, page.items, { queryId, modeUsed: mode, degraded: false, started, embeddingMs, retrievalMs, metadataMs: noteMetadataResult.metadataMs, freshnessMs: freshness.freshnessMs }, freshness.index, page.nextCursor);
}
