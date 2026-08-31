import type { Context } from 'hono';
import { deriveSlug, isUUID, normalizeSlug, validateCreateNoteInput, validateLimit, validateUpdateNoteInput, validateVersionedMutation } from '@qnotes/shared';
import { MarkdownParseError, parseMarkdown } from '@qnotes/markdown';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient, assertSupabase, noteFromRow, requestHash, serviceClient, summaryFromRow } from '../_shared/database.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataBody(context: Context, data: unknown, status = 200): Response {
  return context.json({ data }, status as 200);
}

function noteFromRpc(value: unknown): ReturnType<typeof noteFromRow> {
  const row = record(value);
  const deletedAt = row.deletedAt ?? row.deleted_at;
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    contentMarkdown: String(row.contentMarkdown ?? row.content_markdown ?? ''),
    contentPlain: String(row.contentPlain ?? row.content_plain ?? ''),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    version: Number(row.version),
    createdAt: String(row.createdAt ?? row.created_at),
    updatedAt: String(row.updatedAt ?? row.updated_at),
    deletedAt: deletedAt ? String(deletedAt) : null,
  };
}

function mapMutationResult(data: unknown): NoteResult {
  const result = record(data);
  const status = result.status;
  if (status === 'ok' || status === 'idempotent') return { note: noteFromRpc(result.note), blocks: Array.isArray(result.blocks) ? result.blocks : [] };
  if (status === 'not_found') throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
  if (status === 'slug_conflict') throw new ApiError(409, 'NOTE_SLUG_CONFLICT', 'An active note already uses that slug.');
  if (status === 'mutation_reuse_conflict') throw new ApiError(409, 'MUTATION_REUSE_CONFLICT', 'The mutation ID was already used for a different request.');
  if (status === 'version_conflict') throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', { currentVersion: result.currentVersion, currentNote: result.currentNote });
  throw new ApiError(500, 'INTERNAL_ERROR', 'The note mutation failed.');
}

interface NoteResult {
  note: ReturnType<typeof noteFromRow>;
  blocks: unknown[];
}

function blockDocuments(parsed: Awaited<ReturnType<typeof parseMarkdown>>, title: string) {
  return parsed.blocks.map((block) => ({
    sourceType: block.explicit ? 'copy_block' : 'code_block',
    sourceKey: block.blockKey,
    sourceTitle: block.title ?? block.language ?? title,
    headingPath: null,
    content: block.content,
    contentHash: block.contentHash,
    position: block.position,
  }));
}

async function parsedContent(markdown: string, title: string) {
  try {
    const parsed = await parseMarkdown(markdown);
    const blocks = parsed.blocks.map(({ explicit: _explicit, ...block }) => block);
    return { parsed, blocks, documents: [...parsed.chunks.map((chunk) => ({ sourceType: 'note_chunk', ...chunk })), ...blockDocuments(parsed, title)] };
  } catch (error: unknown) {
    if (error instanceof MarkdownParseError) throw new ApiError(422, error.code, error.message, error.details);
    throw error;
  }
}

export async function findOwnedNote(ownerId: string, noteRef: string, includeDeleted = false): Promise<ReturnType<typeof noteFromRow>> {
  let query = appDbClient.from('notes').select('*').eq('owner_id', ownerId).limit(1);
  query = isUUID(noteRef) ? query.eq('id', noteRef) : query.eq('slug', noteRef.trim().toLowerCase());
  if (!includeDeleted) query = query.is('deleted_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
  return noteFromRow(record(data));
}

export async function listNotes(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const query = context.req.query();
  const limit = validateLimit(query.limit, 100, 50);
  const includeDeleted = query.includeDeleted === 'true';
  let builder = appDbClient.from('notes').select('*').eq('owner_id', auth.userId);
  if (!includeDeleted) builder = builder.is('deleted_at', null);
  if (query.tag) builder = builder.contains('tags', [query.tag.trim().toLowerCase()]);
  if (query.cursor) {
    const cursor = (await import('../_shared/database.ts')).decodeCursor(query.cursor);
    builder = builder.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`);
  }
  const { data, error } = await builder.order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list notes.');
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(summaryFromRow);
  const last = pageRows.at(-1);
  const nextCursor = rows.length > limit && last ? (await import('../_shared/database.ts')).encodeCursor({ updatedAt: String(last.updated_at), id: String(last.id) }) : null;
  return dataBody(context, { items, nextCursor });
}

export async function getNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  return dataBody(context, await findOwnedNote(auth.userId, context.req.param('noteRef')));
}

export async function createNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const input = validateCreateNoteInput(await context.req.json());
  const noteId = crypto.randomUUID();
  const slug = input.slug ?? deriveSlug(input.title, noteId);
  const parsed = await parsedContent(input.contentMarkdown ?? '', input.title);
  const normalizedBody = { title: input.title, slug, contentMarkdown: parsed.parsed.normalizedMarkdown, tags: input.tags ?? [], deviceId: input.deviceId, mutationId: input.mutationId };
  const hash = await requestHash({ userId: auth.userId, operation: 'created', noteId, expectedVersion: null, body: normalizedBody });
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_note', {
    p_owner_id: auth.userId, p_note_id: noteId, p_slug: slug, p_title: input.title, p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText, p_tags: input.tags ?? [], p_device_id: input.deviceId, p_mutation_id: input.mutationId,
    p_request_hash: hash, p_blocks: parsed.blocks, p_documents: parsed.documents,
  }));
  return dataBody(context, mapMutationResult(result).note, 201);
}

export async function updateNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateUpdateNoteInput(await context.req.json());
  const parsed = await parsedContent(input.contentMarkdown, input.title);
  const normalizedBody = { title: input.title, slug: input.slug, contentMarkdown: parsed.parsed.normalizedMarkdown, tags: input.tags, deviceId: input.deviceId, mutationId: input.mutationId };
  const hash = await requestHash({ userId: auth.userId, operation: 'updated', noteId, expectedVersion: input.expectedVersion, body: normalizedBody });
  const result = assertSupabase(await serviceClient.rpc('qnotes_update_note', {
    p_owner_id: auth.userId, p_note_id: noteId, p_slug: normalizeSlug(input.slug, input.title), p_title: input.title, p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText, p_tags: input.tags, p_expected_version: input.expectedVersion, p_device_id: input.deviceId,
    p_mutation_id: input.mutationId, p_request_hash: hash, p_blocks: parsed.blocks, p_documents: parsed.documents,
  }));
  return dataBody(context, mapMutationResult(result).note);
}

async function versionedMutation(context: Context, operation: 'deleted' | 'restored'): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateVersionedMutation(await context.req.json());
  const hash = await requestHash({ userId: auth.userId, operation, noteId, expectedVersion: input.expectedVersion, body: input });
  const functionName = operation === 'deleted' ? 'qnotes_soft_delete_note' : 'qnotes_restore_note';
  const params = operation === 'deleted'
    ? { p_owner_id: auth.userId, p_note_id: noteId, p_expected_version: input.expectedVersion, p_device_id: input.deviceId, p_mutation_id: input.mutationId, p_request_hash: hash }
    : { p_owner_id: auth.userId, p_note_id: noteId, p_expected_version: input.expectedVersion, p_device_id: input.deviceId, p_mutation_id: input.mutationId, p_request_hash: hash };
  const result = assertSupabase(await serviceClient.rpc(functionName, params));
  return dataBody(context, mapMutationResult(result).note);
}

export async function deleteNote(context: Context): Promise<Response> {
  return versionedMutation(context, 'deleted');
}

export async function restoreNote(context: Context): Promise<Response> {
  return versionedMutation(context, 'restored');
}
