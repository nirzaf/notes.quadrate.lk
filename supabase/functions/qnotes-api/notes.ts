import type { Context } from 'hono';
import { deriveSlug, isUUID, normalizeSlug, QNotesValidationError, validateAppendNoteInput, validateCreateNoteInput, validateListNotesQuery, validateMoveNoteToNotebookInput, validateUpdateNoteInput, validateVersionedMutation } from '@qnotes/shared';
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
    notebookId: row.notebookId ? String(row.notebookId) : row.notebook_id ? String(row.notebook_id) : null,
    version: Number(row.version),
    createdAt: String(row.createdAt ?? row.created_at),
    updatedAt: String(row.updatedAt ?? row.updated_at),
    deletedAt: deletedAt ? String(deletedAt) : null,
  };
}

function mapMutationResult(data: unknown): NoteResult {
  const result = record(data);
  const status = result.status;
  if (status === 'ok' || status === 'idempotent' || status === 'dedupe_existing') return { note: noteFromRpc(result.note), blocks: Array.isArray(result.blocks) ? result.blocks : [], status: String(status) };
  if (status === 'not_found') throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
  if (status === 'notebook_not_found') throw new ApiError(404, 'NOTEBOOK_NOT_FOUND', 'The notebook was not found.');
  if (status === 'slug_conflict') throw new ApiError(409, 'NOTE_SLUG_CONFLICT', 'An active note already uses that slug.');
  if (status === 'dedupe_conflict') throw new ApiError(409, 'NOTE_DEDUPE_CONFLICT', 'An active note already uses that dedupe key.');
  if (status === 'mutation_reuse_conflict') throw new ApiError(409, 'MUTATION_REUSE_CONFLICT', 'The mutation ID was already used for a different request.');
  if (status === 'version_conflict') throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', { currentVersion: result.currentVersion, currentNote: result.currentNote });
  throw new ApiError(500, 'INTERNAL_ERROR', 'The note mutation failed.');
}

interface NoteResult {
  note: ReturnType<typeof noteFromRow>;
  blocks: unknown[];
  status: string;
}

export type NoteMutationOutcome = 'applied' | 'idempotent';

export function noteMutationOutcome(status: string): NoteMutationOutcome {
  if (status === 'ok') return 'applied';
  if (status === 'idempotent') return 'idempotent';
  throw new ApiError(500, 'INTERNAL_ERROR', 'The note mutation returned an invalid success status.');
}

export function mutationResponse(context: Context, result: NoteResult): Response {
  const response = dataBody(context, result.note);
  response.headers.set('x-qnotes-mutation-outcome', noteMutationOutcome(result.status));
  return response;
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

function appendMarkdown(existing: string, addition: string): string {
  const normalizedExisting = existing.replace(/\r\n?/g, '\n');
  const normalizedAddition = addition.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!normalizedAddition) return normalizedExisting;
  if (!normalizedExisting) return `${normalizedAddition}\n`;
  return `${normalizedExisting.replace(/\n+$/g, '')}\n\n${normalizedAddition}\n`;
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
  let query: ReturnType<typeof validateListNotesQuery>;
  try {
    query = validateListNotesQuery(context.req.query());
  } catch (error: unknown) {
    if (error instanceof QNotesValidationError) throw new ApiError(422, 'VALIDATION_ERROR', error.message);
    throw error;
  }
  const { limit, includeDeleted, deletedOnly, unfiled, notebookId, tag } = query;
  let builder = appDbClient.from('notes').select('id, slug, title, content_plain, tags, notebook_id, version, created_at, updated_at, deleted_at').eq('owner_id', auth.userId);
  if (deletedOnly) builder = builder.not('deleted_at', 'is', null);
  else if (!includeDeleted) builder = builder.is('deleted_at', null);
  if (notebookId) builder = builder.eq('notebook_id', notebookId);
  if (unfiled) builder = builder.is('notebook_id', null);
  if (tag) builder = builder.contains('tags', [tag]);
  if (query.cursor) {
    const cursor = (await import('../_shared/database.ts')).decodeCursor(query.cursor);
    builder = builder.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
  }
  const { data, error } = await builder.order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
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
  return dataBody(context, await findOwnedNote(auth.userId, context.req.param('noteRef'), context.req.query('includeDeleted') === 'true'));
}

export async function createNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const input = validateCreateNoteInput(await context.req.json());
  const noteId = crypto.randomUUID();
  const slug = input.slug ?? deriveSlug(input.title);
  const parsed = await parsedContent(input.contentMarkdown ?? '', input.title);
  const normalizedBody = {
    title: input.title,
    requestedSlug: input.slug ?? null,
    contentMarkdown: parsed.parsed.normalizedMarkdown,
    tags: input.tags ?? [],
    notebookId: input.notebookId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    deviceId: input.deviceId,
    mutationId: input.mutationId,
  };
  const hash = await requestHash({ userId: auth.userId, operation: 'created', body: normalizedBody });
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_note', {
    p_owner_id: auth.userId, p_note_id: noteId, p_slug: slug, p_title: input.title, p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText, p_tags: input.tags ?? [], p_device_id: input.deviceId, p_mutation_id: input.mutationId,
    p_request_hash: hash, p_blocks: parsed.blocks, p_documents: parsed.documents, p_notebook_id: input.notebookId ?? null, p_dedupe_key: input.dedupeKey ?? null,
  }));
  const mapped = mapMutationResult(result);
  const outcome = mapped.status === 'ok' ? 'created' : mapped.status === 'idempotent' ? 'idempotent' : 'deduplicated';
  const response = dataBody(context, mapped.note, outcome === 'created' ? 201 : 200);
  response.headers.set('x-qnotes-create-outcome', outcome);
  return response;
}

export async function updateNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateUpdateNoteInput(await context.req.json());
  const currentNote = input.tags === undefined ? await findOwnedNote(auth.userId, noteId) : null;
  const tags = input.tags ?? currentNote?.tags ?? [];
  const parsed = await parsedContent(input.contentMarkdown, input.title);
  const normalizedBody = { title: input.title, slug: input.slug, contentMarkdown: parsed.parsed.normalizedMarkdown, ...(input.tags === undefined ? {} : { tags: input.tags }), deviceId: input.deviceId, mutationId: input.mutationId };
  const hash = await requestHash({ userId: auth.userId, operation: 'updated', noteId, expectedVersion: input.expectedVersion, body: normalizedBody });
  const result = assertSupabase(await serviceClient.rpc('qnotes_update_note', {
    p_owner_id: auth.userId, p_note_id: noteId, p_slug: normalizeSlug(input.slug, input.title), p_title: input.title, p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText, p_tags: tags, p_expected_version: input.expectedVersion, p_device_id: input.deviceId,
    p_mutation_id: input.mutationId, p_request_hash: hash, p_blocks: parsed.blocks, p_documents: parsed.documents,
  }));
  return mutationResponse(context, mapMutationResult(result));
}

export async function appendNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateAppendNoteInput(await context.req.json());
  const currentNote = await findOwnedNote(auth.userId, noteId, true);
  const expectedVersion = input.expectedVersion ?? currentNote.version;
  const parsed = await parsedContent(appendMarkdown(currentNote.contentMarkdown, input.contentMarkdown), currentNote.title);
  // expectedVersion is an optimistic precondition, not part of the logical
  // append identity. A committed replay must still match after later writes.
  const hash = await requestHash({
    userId: auth.userId,
    operation: 'appended',
    noteId,
    body: { contentMarkdown: input.contentMarkdown, deviceId: input.deviceId, mutationId: input.mutationId },
  });
  const result = assertSupabase(await serviceClient.rpc('qnotes_append_note', {
    p_owner_id: auth.userId,
    p_note_id: noteId,
    p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText,
    p_expected_version: expectedVersion,
    p_device_id: input.deviceId,
    p_mutation_id: input.mutationId,
    p_request_hash: hash,
    p_blocks: parsed.blocks,
    p_documents: parsed.documents,
  }));
  return mutationResponse(context, mapMutationResult(result));
}

export async function moveNoteToNotebook(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateMoveNoteToNotebookInput(await context.req.json());
  const hash = await requestHash({ userId: auth.userId, operation: 'updated', noteId, expectedVersion: input.expectedVersion, body: input });
  const result = assertSupabase(await serviceClient.rpc('qnotes_move_note_to_notebook', {
    p_owner_id: auth.userId,
    p_note_id: noteId,
    p_notebook_id: input.notebookId,
    p_expected_version: input.expectedVersion,
    p_device_id: input.deviceId,
    p_mutation_id: input.mutationId,
    p_request_hash: hash,
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
  return mutationResponse(context, mapMutationResult(result));
}

export async function deleteNote(context: Context): Promise<Response> {
  return versionedMutation(context, 'deleted');
}

export async function restoreNote(context: Context): Promise<Response> {
  return versionedMutation(context, 'restored');
}
