import type { Context } from 'hono';
import type { SearchContext, SearchSourceType } from '@qnotes/shared';
import { isUUID } from '@qnotes/shared';
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
  position: number;
  page_number: number | null;
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

function parseRequest(documentId: unknown, values: { before?: unknown; after?: unknown; maxTokens?: unknown }): ContextRequest {
  if (!isUUID(documentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'documentId must be a valid UUID.');
  const before = bodyInteger(values.before, 'before', DEFAULT_BEFORE, MAX_CONTEXT_NEIGHBORS);
  const after = bodyInteger(values.after, 'after', DEFAULT_AFTER, MAX_CONTEXT_NEIGHBORS);
  const maxTokens = bodyInteger(values.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS, MAX_CONTEXT_TOKENS);
  if (maxTokens < 1) throw new ApiError(422, 'VALIDATION_ERROR', 'maxTokens must be positive.');
  return { documentId, before, after, maxTokens };
}

function approximateTokens(value: string): number {
  return Math.ceil(value.trim().length / 4);
}

function truncate(value: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function takeNeighbors(rows: SearchDocumentRow[], maxTokens: number): string[] {
  const values: string[] = [];
  let remaining = maxTokens;
  for (const row of rows) {
    if (remaining < 1) break;
    const value = truncate(row.content, remaining);
    if (!value) continue;
    values.push(value);
    remaining -= Math.max(1, approximateTokens(value));
  }
  return values;
}

async function loadDocument(userId: string, documentId: string): Promise<SearchDocumentRow> {
  const { data, error } = await appDbClient
    .from('search_documents')
    .select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, position, page_number')
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
  const previousBase = appDbClient.from('search_documents').select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, position, page_number').eq('owner_id', userId).eq('note_id', document.note_id).eq('source_type', document.source_type).lt('position', document.position);
  const nextBase = appDbClient.from('search_documents').select('id, note_id, source_type, source_id, source_key, source_title, heading_path, content, position, page_number').eq('owner_id', userId).eq('note_id', document.note_id).eq('source_type', document.source_type).gt('position', document.position);
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
  const document = await loadDocument(userId, request.documentId);
  const note = await loadNote(userId, document.note_id);
  const neighbors = await loadNeighbors(userId, document, request);
  let remainingTokens = request.maxTokens;
  const content = truncate(document.content, remainingTokens);
  remainingTokens = Math.max(0, remainingTokens - Math.max(1, approximateTokens(content)));
  const previous = takeNeighbors(neighbors.previous, Math.floor(remainingTokens / 2));
  const previousTokens = previous.reduce((sum, value) => sum + Math.max(1, approximateTokens(value)), 0);
  const next = takeNeighbors(neighbors.next, Math.max(0, remainingTokens - previousTokens));
  return {
    noteId: note.id,
    noteVersion: note.version,
    documentId: document.id,
    uri: `qnotes://notes/${note.id}/documents/${document.id}`,
    title: note.title || document.source_title,
    headingPath: document.heading_path,
    content,
    previous,
    next,
    updatedAt: note.updated_at,
    sourceType: document.source_type as SearchSourceType,
    sourceId: document.source_id,
    sourceKey: document.source_key,
    sourceTitle: document.source_title,
    attachmentId: document.source_type === 'attachment_chunk' ? document.source_id : null,
    pageNumber: document.page_number,
  };
}

export async function getNoteContext(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const query = context.req.query();
  const request = parseRequest(context.req.param('documentId'), { before: query.before, after: query.after, maxTokens: query.maxTokens });
  return dataBody(context, await contextFor(auth.userId, request));
}

export async function postNoteContext(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'search:read');
  const body = record(await context.req.json().catch(() => null));
  const request = parseRequest(body.documentId, { before: body.before, after: body.after, maxTokens: body.maxTokens });
  return dataBody(context, await contextFor(auth.userId, request));
}
