import type { Context } from 'hono';
import type { SearchContext, SearchContextContinuation, SearchSourceType } from '@qnotes/shared';
import { boundContextSource, contextNoteChanged, contextTokenUsage, isUUID, takeContextSources, type ContextSourceInput } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient } from '../_shared/database.ts';

const DEFAULT_BEFORE = 1;
const DEFAULT_AFTER = 1;
const DEFAULT_MAX_TOKENS = 1800;
const MAX_CONTEXT_NEIGHBORS = 5;
const MAX_CONTEXT_TOKENS = 4000;

interface ContextRequest {
  documentId: string;
  before: number;
  after: number;
  maxTokens: number;
  continuation?: string;
}

interface SearchDocumentRow {
  id: string;
  note_id: string;
  source_type: string;
  source_id: string | null;
  source_key: string;
  source_title: string;
  heading_path: string | null;
  content: string;
  content_hash: string;
  position: number;
  page_number: number | null;
}

interface SearchDocumentReferenceRow {
  id: string;
  note_id: string;
}

interface NoteRow {
  id: string;
  version: number;
  title: string;
  updated_at: string;
}

function dataBody(context: Context, data: SearchContext): Response {
  return context.json({ data });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be an integer from 0 to ${max}.`);
  return parsed;
}

function parseRequest(documentId: unknown, values: { before?: unknown; after?: unknown; maxTokens?: unknown; continuation?: unknown }): ContextRequest {
  if (!isUUID(documentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'documentId must be a valid UUID.');
  const before = bodyInteger(values.before, 'before', DEFAULT_BEFORE, MAX_CONTEXT_NEIGHBORS);
  const after = bodyInteger(values.after, 'after', DEFAULT_AFTER, MAX_CONTEXT_NEIGHBORS);
  const maxTokens = bodyInteger(values.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS, MAX_CONTEXT_TOKENS);
  if (maxTokens < 1) throw new ApiError(422, 'VALIDATION_ERROR', 'maxTokens must be positive.');
  if (values.continuation !== undefined && (typeof values.continuation !== 'string' || values.continuation.length > 8192)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation must be an opaque token no longer than 8192 characters.');
  }
  return { documentId, before, after, maxTokens, ...(values.continuation === undefined ? {} : { continuation: values.continuation }) };
}

interface ContinuationPayload {
  documentId: string;
  noteId: string;
  noteVersion: number;
  sourceHash: string;
  nextOffset: number;
}

function encodeContinuation(payload: ContinuationPayload): string {
  return btoa(JSON.stringify({ version: 1, ...payload })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeContinuation(value: string): ContinuationPayload {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const parsed = record(JSON.parse(atob(padded)));
    if (
      parsed.version !== 1
      || !isUUID(parsed.documentId)
      || !isUUID(parsed.noteId)
      || !Number.isSafeInteger(parsed.noteVersion)
      || !Number.isSafeInteger(parsed.nextOffset)
      || parsed.nextOffset < 0
      || typeof parsed.sourceHash !== 'string'
      || parsed.sourceHash.length === 0
    ) throw new Error('invalid continuation');
    return {
      documentId: parsed.documentId,
      noteId: parsed.noteId,
      noteVersion: parsed.noteVersion,
      sourceHash: parsed.sourceHash,
      nextOffset: parsed.nextOffset,
    };
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
  }
}

function sourceInput(row: SearchDocumentRow, note: NoteRow): ContextSourceInput {
  return {
    documentId: row.id,
    noteId: note.id,
    noteVersion: note.version,
    sourceType: row.source_type as SearchSourceType,
    sourceId: row.source_id,
    sourceKey: row.source_key,
    sourceTitle: row.source_title,
    headingPath: row.heading_path,
    attachmentId: row.source_type === 'attachment_chunk' ? row.source_id : null,
    pageNumber: row.page_number,
    content: row.content,
    sourceHash: row.content_hash,
  };
}

async function loadDocumentReference(userId: string, documentId: string): Promise<SearchDocumentReferenceRow> {
  const { data, error } = await appDbClient
    .from('search_documents')
    .select('id, note_id')
    .eq('id', documentId)
    .eq('owner_id', userId)
    .maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The search document was not found.');
  return data as unknown as SearchDocumentReferenceRow;
}

async function loadDocument(userId: string, documentId: string): Promise<SearchDocumentRow> {
  const { data, error } = await appDbClient
    .from('search_documents')
    .select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, page_number')
    .eq('id', documentId)
    .eq('owner_id', userId)
    .maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The search document was not found.');
  return data as unknown as SearchDocumentRow;
}

async function loadNote(userId: string, noteId: string): Promise<NoteRow> {
  const { data, error } = await appDbClient
    .from('notes')
    .select('id, version, title, updated_at')
    .eq('id', noteId)
    .eq('owner_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The owning note was not found.');
  return data as unknown as NoteRow;
}

async function loadNeighbors(userId: string, document: SearchDocumentRow, request: ContextRequest): Promise<{ previous: SearchDocumentRow[]; next: SearchDocumentRow[] }> {
  if (document.source_type === 'note_metadata' || document.source_type === 'copy_block' || document.source_type === 'code_block') return { previous: [], next: [] };
  const previousBase = appDbClient.from('search_documents').select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, page_number').eq('owner_id', userId).eq('note_id', document.note_id).eq('source_type', document.source_type).lt('position', document.position);
  const nextBase = appDbClient.from('search_documents').select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, page_number').eq('owner_id', userId).eq('note_id', document.note_id).eq('source_type', document.source_type).gt('position', document.position);
  const previousScoped = document.source_id ? previousBase.eq('source_id', document.source_id) : previousBase.is('source_id', null);
  const nextScoped = document.source_id ? nextBase.eq('source_id', document.source_id) : nextBase.is('source_id', null);
  const [previousResult, nextResult] = await Promise.all([
    request.before > 0
      ? previousScoped.order('position', { ascending: false }).limit(request.before)
      : Promise.resolve({ data: [], error: null }),
    request.after > 0
      ? nextScoped.order('position', { ascending: true }).limit(request.after)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (previousResult.error || nextResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to retrieve document context.');
  return {
    previous: (Array.isArray(previousResult.data) ? previousResult.data : []).reverse() as unknown as SearchDocumentRow[],
    next: (Array.isArray(nextResult.data) ? nextResult.data : []) as unknown as SearchDocumentRow[],
  };
}

async function contextFor(userId: string, request: ContextRequest): Promise<SearchContext> {
  const continuation = request.continuation ? decodeContinuation(request.continuation) : null;
  if (continuation && continuation.documentId !== request.documentId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation belongs to a different document.');
  }
  const documentReference = await loadDocumentReference(userId, request.documentId);
  if (continuation && continuation.noteId !== documentReference.note_id) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation belongs to a different note.');
  }
  const noteBefore = await loadNote(userId, documentReference.note_id);
  const document = await loadDocument(userId, request.documentId);
  const neighbors = continuation ? { previous: [], next: [] } : await loadNeighbors(userId, document, request);
  const noteAfter = await loadNote(userId, document.note_id);
  if (contextNoteChanged(noteBefore, noteAfter)) {
    throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note changed while context was being read. Retry the context request.', {
      currentVersion: noteAfter.version,
      currentUpdatedAt: noteAfter.updated_at,
    });
  }
  if (continuation && (continuation.noteVersion !== noteAfter.version || continuation.sourceHash !== document.content_hash)) {
    throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The context continuation is stale. Read a new context page.', {
      currentVersion: noteAfter.version,
      currentUpdatedAt: noteAfter.updated_at,
    });
  }
  const documentCharacters = Array.from(document.content);
  const offset = continuation?.nextOffset ?? 0;
  if (offset > documentCharacters.length) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation offset is invalid.');
  const center = boundContextSource(sourceInput({ ...document, content: documentCharacters.slice(offset).join('') }, noteAfter), request.maxTokens);
  let usedTokens = contextTokenUsage(center.content);
  const remainingAfterCenter = Math.max(0, request.maxTokens - usedTokens);
  const previousSources = takeContextSources(neighbors.previous.map((row) => sourceInput(row, noteAfter)), Math.floor(remainingAfterCenter / 2));
  usedTokens += previousSources.reduce((sum, source) => sum + contextTokenUsage(source.content), 0);
  const nextSources = takeContextSources(neighbors.next.map((row) => sourceInput(row, noteAfter)), Math.max(0, request.maxTokens - usedTokens));
  usedTokens += nextSources.reduce((sum, source) => sum + contextTokenUsage(source.content), 0);
  const nextOffset = offset + documentCharacters.slice(offset, offset + Array.from(center.content).length).length;
  const hasMore = nextOffset < documentCharacters.length;
  const nextContinuation: SearchContextContinuation | undefined = hasMore ? {
    cursor: encodeContinuation({ documentId: document.id, noteId: noteAfter.id, noteVersion: noteAfter.version, sourceHash: document.content_hash, nextOffset }),
    noteVersion: noteAfter.version,
    sourceHash: document.content_hash,
    nextOffset,
  } : undefined;
  return {
    noteId: noteAfter.id,
    noteVersion: noteAfter.version,
    documentId: document.id,
    uri: `qnotes://notes/${noteAfter.id}/documents/${document.id}`,
    title: noteAfter.title || document.source_title,
    headingPath: document.heading_path,
    content: center.content,
    previous: previousSources.map((source) => source.content),
    next: nextSources.map((source) => source.content),
    updatedAt: noteAfter.updated_at,
    sourceType: document.source_type as SearchSourceType,
    sourceId: document.source_id,
    sourceKey: document.source_key,
    sourceTitle: document.source_title,
    attachmentId: document.source_type === 'attachment_chunk' ? document.source_id : null,
    pageNumber: document.page_number,
    sourceHash: center.sourceHash,
    truncated: center.truncated || previousSources.some((source) => source.truncated) || nextSources.some((source) => source.truncated) || hasMore,
    tokenBudget: { max: request.maxTokens, used: usedTokens, unit: 'approximate_tokens' },
    ...(nextContinuation ? { continuation: nextContinuation } : {}),
    previousSources,
    nextSources,
  };
}

export async function getNoteContext(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const query = context.req.query();
  const request = parseRequest(context.req.param('documentId'), { before: query.before, after: query.after, maxTokens: query.maxTokens, continuation: query.continuation });
  return dataBody(context, await contextFor(auth.userId, request));
}

export async function postNoteContext(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const body = record(await context.req.json().catch(() => null));
  const request = parseRequest(body.documentId, { before: body.before, after: body.after, maxTokens: body.maxTokens, continuation: body.continuation });
  return dataBody(context, await contextFor(auth.userId, request));
}
