import type { Context } from 'hono';
import { deriveSlug, isUUID, MAX_MARKDOWN_CODE_UNITS, MAX_PATCH_REPLACEMENT_BYTES, MAX_SEARCH_LIMIT, MAX_SYNC_LIMIT, normalizeSlug, QNotesValidationError, validateAppendNoteInput, validateCreateNoteInput, validateListNotesQuery, validateMoveNoteToNotebookInput, validatePatchNoteSectionInput, validateUpdateNoteInput, validateVersionedMutation, type ApiTokenScope, type CreateNoteInput, type PatchNoteSectionInput } from '@qnotes/shared';
import { getMarkdownOutline, MarkdownParseError, MarkdownPatchError, parseMarkdown, patchMarkdownSection } from '@qnotes/markdown';
import { splitEmbeddingContent } from '@qnotes/markdown';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient, assertSupabase, noteFromRow, requestHash, serviceClient, summaryFromRow } from '../_shared/database.ts';
import { applyNotebookAccess, assertNotebookAccess, assertNoteAccess, assertUnfiledAccess, authPrincipal, requireCursorPolicy } from '../_shared/notebook-access.ts';
import { asCursorInteger, asCursorString, decodeReadCursor, encodeReadCursor, fitJsonContent, parseReadRange, resolveReadRange, sha256Hex } from './read-range.ts';

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

const ALL_API_SCOPES: ApiTokenScope[] = ['notes:read', 'notes:write', 'search:read', 'shares:write', 'attachments:read', 'attachments:write'];
const MAX_OUTLINE_SECTIONS = 500;
const MAX_OUTLINE_BLOCKS = 500;
const WRITE_OPERATIONS = ['capture_note', 'append_note', 'update_note', 'preview_note_section', 'patch_note_section', 'delete_note', 'restore_note', 'move_note_to_notebook'];

function hasScope(auth: ReturnType<typeof authFromContext>, scope: ApiTokenScope): boolean {
  return auth.authKind === 'jwt' || auth.scopes?.includes(scope) === true;
}

function effectiveProfile(auth: ReturnType<typeof authFromContext>): 'read' | 'share' | 'write' {
  if (hasScope(auth, 'notes:write')) return 'write';
  if (hasScope(auth, 'shares:write')) return 'share';
  return 'read';
}

function mutationStatusScope(auth: ReturnType<typeof authFromContext>): void {
  if (!hasScope(auth, 'notes:read') && !hasScope(auth, 'notes:write')) throw new ApiError(403, 'INSUFFICIENT_SCOPE', 'The token does not have a note scope.');
}

interface StoredMutation {
  mutationId: string;
  operation: string;
  requestHash: string;
  noteId: string;
  resultingVersion: number;
  response: Record<string, unknown>;
  createdAt: string;
}

async function findMutation(ownerId: string, mutationId: string): Promise<StoredMutation | null> {
  const { data, error } = await appDbClient.from('note_mutations')
    .select('mutation_id, operation, request_hash, note_id, resulting_version, response, created_at')
    .eq('owner_id', ownerId)
    .eq('mutation_id', mutationId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to read the mutation receipt.');
  if (!data) return null;
  const row = record(data);
  return {
    mutationId: String(row.mutation_id),
    operation: String(row.operation),
    requestHash: String(row.request_hash),
    noteId: String(row.note_id),
    resultingVersion: Number(row.resulting_version),
    response: record(row.response),
    createdAt: String(row.created_at),
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

async function blockDocuments(parsed: Awaited<ReturnType<typeof parseMarkdown>>, title: string) {
  const documents: Array<Record<string, unknown>> = [];
  for (const block of parsed.blocks) {
    const sourceType = block.explicit ? 'copy_block' : 'code_block';
    const sourceTitle = block.title ?? block.language ?? title;
    const parts = splitEmbeddingContent(block.content, sourceTitle, null);
    const safeParts = parts.length ? parts : [block.content];
    for (const [index, content] of safeParts.entries()) {
      const contentHash = await sha256Hex(content.trim());
      documents.push({
        sourceType,
        sourceKey: safeParts.length > 1 ? `${block.blockKey}:chunk:${index}-${contentHash.slice(0, 16)}` : block.blockKey,
        blockKey: block.blockKey,
        sourceTitle,
        headingPath: null,
        content,
        contentHash,
        position: Math.min(2_147_483_647, Math.max(0, block.position + index)),
      });
    }
  }
  return documents;
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
    return { parsed, blocks, documents: [...parsed.chunks.map((chunk) => ({ sourceType: 'note_chunk', ...chunk })), ...(await blockDocuments(parsed, title))] };
  } catch (error: unknown) {
    if (error instanceof MarkdownParseError) throw new ApiError(422, error.code, error.message, error.details);
    throw error;
  }
}

interface NoteUpdateRequest {
  title: string;
  slug: string;
  contentMarkdown: string;
  tags: string[];
  expectedVersion: number;
  deviceId: string;
  mutationId: string;
}

async function applyNoteUpdate(ownerId: string, noteId: string, input: NoteUpdateRequest, hash: string): Promise<NoteResult> {
  const parsed = await parsedContent(input.contentMarkdown, input.title);
  const result = assertSupabase(await serviceClient.rpc('qnotes_update_note', {
    p_owner_id: ownerId,
    p_note_id: noteId,
    p_slug: normalizeSlug(input.slug, input.title),
    p_title: input.title,
    p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText,
    p_tags: input.tags,
    p_expected_version: input.expectedVersion,
    p_device_id: input.deviceId,
    p_mutation_id: input.mutationId,
    p_request_hash: hash,
    p_blocks: parsed.blocks,
    p_documents: parsed.documents,
  }));
  return mapMutationResult(result);
}

export async function findOwnedNote(ownerId: string, noteRef: string, includeDeleted = false): Promise<ReturnType<typeof noteFromRow>> {
  let query = appDbClient.from('notes').select('*').eq('owner_id', ownerId).limit(1);
  if (isUUID(noteRef)) query = query.eq('id', noteRef);
  else query = query.eq('slug', (noteRef as string).trim().toLowerCase());
  if (!includeDeleted) query = query.is('deleted_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
  return noteFromRow(record(data));
}

export async function findAuthorizedNote(auth: ReturnType<typeof authFromContext>, noteRef: string, includeDeleted = false): Promise<ReturnType<typeof noteFromRow>> {
  const note = await findOwnedNote(auth.userId, noteRef, includeDeleted);
  assertNoteAccess(auth, note.notebookId);
  return note;
}

export async function getCapabilities(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  const supportedOperations = ['get_capabilities', 'resolve_public_share'];
  if (hasScope(auth, 'search:read')) supportedOperations.push('search_notes', 'read_note_context');
  if (hasScope(auth, 'notes:read')) supportedOperations.push('get_block', 'list_notebooks', 'list_note_changes', 'get_note_outline');
  if (hasScope(auth, 'notes:read') || hasScope(auth, 'notes:write')) supportedOperations.push('get_mutation_status');
  if (hasScope(auth, 'notes:write')) supportedOperations.push(...WRITE_OPERATIONS);
  if (hasScope(auth, 'shares:write')) supportedOperations.push('create_public_share');
  return dataBody(context, {
    schemaVersion: 1,
    effectiveProfile: effectiveProfile(auth),
    scopes: auth.scopes ? [...auth.scopes] : [...ALL_API_SCOPES],
    supportedOperations,
    responseLimits: {
      searchResults: MAX_SEARCH_LIMIT,
      contextTokens: 4000,
      noteChanges: MAX_SYNC_LIMIT,
      outlineSections: MAX_OUTLINE_SECTIONS,
      patchReplacementBytes: MAX_PATCH_REPLACEMENT_BYTES,
    },
  });
}

export async function getNoteOutline(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '');
  const outline = await getMarkdownOutline(note.contentMarkdown);
  return dataBody(context, {
    noteId: note.id,
    noteVersion: note.version,
    markdownHash: outline.markdownHash,
    sections: outline.sections.slice(0, MAX_OUTLINE_SECTIONS),
    blocks: outline.blocks.slice(0, MAX_OUTLINE_BLOCKS),
    truncated: outline.sections.length > MAX_OUTLINE_SECTIONS || outline.blocks.length > MAX_OUTLINE_BLOCKS,
  });
}

export async function previewNoteSection(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  let input: PatchNoteSectionInput;
  try {
    input = validatePatchNoteSectionInput(await context.req.json());
  } catch (error: unknown) {
    if (error instanceof QNotesValidationError) throw new ApiError(422, 'VALIDATION_ERROR', error.message);
    throw error;
  }
  const currentNote = await findAuthorizedNote(auth, noteId);
  if (currentNote.version !== input.expectedVersion) throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', { currentVersion: currentNote.version });
  let patchedMarkdown: string;
  let preview: Awaited<ReturnType<typeof getMarkdownOutline>>;
  try {
    patchedMarkdown = await patchMarkdownSection(currentNote.contentMarkdown, input.sectionId, input.expectedContentHash, input.replacementMarkdown);
    preview = await getMarkdownOutline(patchedMarkdown);
  } catch (error: unknown) {
    if (error instanceof MarkdownPatchError) throw new ApiError(409, 'NOTE_SECTION_CONFLICT', 'The note section is stale or ambiguous.', { currentVersion: currentNote.version });
    if (error instanceof MarkdownParseError) throw new ApiError(422, error.code, error.message, error.details);
    throw error;
  }
  if (patchedMarkdown.length > MAX_MARKDOWN_CODE_UNITS) throw new ApiError(422, 'VALIDATION_ERROR', 'contentMarkdown is too large.');
  return dataBody(context, {
    noteId,
    currentVersion: currentNote.version,
    sectionId: input.sectionId,
    currentContentHash: input.expectedContentHash,
    replacementBytes: new TextEncoder().encode(input.replacementMarkdown).byteLength,
    resultingMarkdownHash: preview!.markdownHash,
    wouldChange: patchedMarkdown !== currentNote.contentMarkdown,
  });
}

async function replayPatchMutation(context: Context, auth: ReturnType<typeof authFromContext>, noteId: string, mutationId: string, hash: string): Promise<Response | null> {
  const stored = await findMutation(auth.userId, mutationId);
  if (!stored) return null;
  if (stored.noteId !== noteId || stored.requestHash !== hash) throw new ApiError(409, 'MUTATION_REUSE_CONFLICT', 'The mutation ID was already used for a different request.');
  await findAuthorizedNote(auth, noteId, true);
  const note = stored.response.note;
  if (!note) throw new ApiError(500, 'INTERNAL_ERROR', 'The mutation receipt is malformed.');
  return mutationResponse(context, { note: noteFromRpc(note), blocks: [], status: 'idempotent' });
}

export async function patchNoteSection(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  let input: PatchNoteSectionInput;
  try {
    input = validatePatchNoteSectionInput(await context.req.json());
  } catch (error: unknown) {
    if (error instanceof QNotesValidationError) throw new ApiError(422, 'VALIDATION_ERROR', error.message);
    throw error;
  }
  const hash = await requestHash({
    userId: auth.userId,
    operation: 'patched_section',
    noteId,
    expectedVersion: input.expectedVersion,
    body: {
      sectionId: input.sectionId,
      expectedContentHash: input.expectedContentHash,
      replacementMarkdown: input.replacementMarkdown,
      deviceId: input.deviceId,
      mutationId: input.mutationId,
    },
  });
  const replay = await replayPatchMutation(context, auth, noteId, input.mutationId, hash);
  if (replay) return replay;

  const currentNote = await findAuthorizedNote(auth, noteId, true);
  if (currentNote.version !== input.expectedVersion) throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', { currentVersion: currentNote.version });
  let patchedMarkdown: string;
  try {
    patchedMarkdown = await patchMarkdownSection(currentNote.contentMarkdown, input.sectionId, input.expectedContentHash, input.replacementMarkdown);
  } catch (error: unknown) {
    const retry = await replayPatchMutation(context, auth, noteId, input.mutationId, hash);
    if (retry) return retry;
    if (error instanceof MarkdownPatchError) throw new ApiError(409, 'NOTE_SECTION_CONFLICT', 'The note section is stale or ambiguous.', { currentVersion: currentNote.version });
    throw error;
  }
  if (patchedMarkdown.length > MAX_MARKDOWN_CODE_UNITS) throw new ApiError(422, 'VALIDATION_ERROR', 'contentMarkdown is too large.');
  const result = await applyNoteUpdate(auth.userId, noteId, {
    title: currentNote.title,
    slug: currentNote.slug,
    contentMarkdown: patchedMarkdown,
    tags: currentNote.tags,
    expectedVersion: input.expectedVersion,
    deviceId: input.deviceId,
    mutationId: input.mutationId,
  }, hash);
  return mutationResponse(context, result);
}

export async function getMutationStatus(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  mutationStatusScope(auth);
  const mutationId = context.req.param('mutationId') ?? '';
  if (!isUUID(mutationId)) throw new ApiError(422, 'VALIDATION_ERROR', 'mutationId must be a valid UUID.');
  const stored = await findMutation(auth.userId, mutationId);
  if (!stored) throw new ApiError(404, 'MUTATION_NOT_FOUND', 'The mutation receipt was not found.');
  await findAuthorizedNote(auth, stored.noteId, true);
  return dataBody(context, {
    mutationId: stored.mutationId,
    operation: stored.operation,
    noteId: stored.noteId,
    resultingVersion: stored.resultingVersion,
    createdAt: stored.createdAt,
    status: 'committed',
  });
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
  builder = applyNotebookAccess(builder, auth);
  if (deletedOnly) builder = builder.not('deleted_at', 'is', null);
  else if (!includeDeleted) builder = builder.is('deleted_at', null);
  if (notebookId) builder = builder.eq('notebook_id', notebookId);
  if (unfiled) builder = builder.is('notebook_id', null);
  if (tag) builder = builder.contains('tags', [tag]);
  if (query.cursor) {
    const cursor = (await import('../_shared/database.ts')).decodeCursor(query.cursor);
    requireCursorPolicy(auth, cursor.principal, cursor.policyRevision);
    builder = builder.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
  }
  const { data, error } = await builder.order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list notes.');
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(summaryFromRow);
  const last = pageRows.at(-1);
  const nextCursor = rows.length > limit && last ? (await import('../_shared/database.ts')).encodeCursor({ updatedAt: String(last.updated_at), id: String(last.id), principal: authPrincipal(auth), policyRevision: auth.policyRevision }) : null;
  return dataBody(context, { items, nextCursor });
}

export async function getNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '', context.req.query('includeDeleted') === 'true');
  const query = context.req.query();
  const rangeRequest = parseReadRange({ offset: query.offset, lineStart: query.lineStart, lineEnd: query.lineEnd, maxBytes: query.maxBytes, continuation: query.continuation });
  if (Object.keys(rangeRequest).length === 0) return dataBody(context, note);
  const sourceHash = await sha256Hex(note.contentMarkdown);
  let range = resolveReadRange(note.contentMarkdown, rangeRequest);
  let rangeStart = range.startOffset;
  if (rangeRequest.continuation) {
    const cursor = decodeReadCursor(rangeRequest.continuation);
    if (cursor.kind !== 'note' || cursor.noteId !== note.id || cursor.sourceHash !== sourceHash) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation belongs to a different note.');
    requireCursorPolicy(auth, asCursorString(cursor, 'principal'), asCursorInteger(cursor, 'policyRevision'));
    if (asCursorInteger(cursor, 'noteVersion', 1) !== note.version) throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The note continuation is stale. Read a new note page.');
    const rangeEnd = asCursorInteger(cursor, 'rangeEnd');
    rangeStart = asCursorInteger(cursor, 'rangeStart');
    const nextOffset = asCursorInteger(cursor, 'nextOffset');
    if (rangeStart > rangeEnd || nextOffset >= rangeEnd || rangeEnd > range.endOffset) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
    range = { ...range, startOffset: nextOffset, endOffset: rangeEnd };
  }
  return dataBody(context, fitJsonContent(note.contentMarkdown, range, (slice, pageTruncated) => {
    const contentComplete = !pageTruncated && rangeStart === 0 && range.endOffset === slice.totalBytes;
    const continuation = pageTruncated ? encodeReadCursor({
      kind: 'note', noteId: note.id, noteVersion: note.version, sourceHash,
      rangeStart, rangeEnd: range.endOffset, nextOffset: slice.endOffset, principal: authPrincipal(auth), policyRevision: auth.policyRevision,
    }) : undefined;
    const pagedNote = { ...note } as Omit<typeof note, 'contentPlain'> & { contentPlain?: string };
    delete pagedNote.contentPlain;
    return {
      ...pagedNote,
      contentMarkdown: slice.content,
      contentBytes: slice.endOffset - slice.startOffset,
      totalBytes: slice.totalBytes,
      offset: slice.startOffset,
      nextOffset: slice.endOffset,
      truncated: !contentComplete,
      contentComplete,
      sourceHash,
      ...(continuation ? { continuation: { cursor: continuation, sourceHash, nextOffset: slice.endOffset, totalBytes: slice.totalBytes, noteVersion: note.version } } : {}),
    };
  }));
}

export async function createNoteMutation(ownerId: string, input: CreateNoteInput, noteId: string): Promise<NoteResult> {
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
  const hash = await requestHash({ userId: ownerId, operation: 'created', body: normalizedBody });
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_note', {
    p_owner_id: ownerId, p_note_id: noteId, p_slug: slug, p_title: input.title, p_content_markdown: parsed.parsed.normalizedMarkdown,
    p_content_plain: parsed.parsed.plainText, p_tags: input.tags ?? [], p_device_id: input.deviceId, p_mutation_id: input.mutationId,
    p_request_hash: hash, p_blocks: parsed.blocks, p_documents: parsed.documents, p_notebook_id: input.notebookId ?? null, p_dedupe_key: input.dedupeKey ?? null,
  }));
  return mapMutationResult(result);
}

export async function createNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const input = validateCreateNoteInput(await context.req.json());
  if (input.notebookId) assertNotebookAccess(auth, input.notebookId);
  else assertUnfiledAccess(auth);
  const mapped = await createNoteMutation(auth.userId, input, crypto.randomUUID());
  assertNoteAccess(auth, mapped.note.notebookId);
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
  const currentNote = await findAuthorizedNote(auth, noteId, true);
  const tags = input.tags ?? currentNote.tags;
  const parsed = await parsedContent(input.contentMarkdown, input.title);
  const normalizedBody = { title: input.title, slug: input.slug, contentMarkdown: parsed.parsed.normalizedMarkdown, ...(input.tags === undefined ? {} : { tags: input.tags }), deviceId: input.deviceId, mutationId: input.mutationId };
  const hash = await requestHash({ userId: auth.userId, operation: 'updated', noteId, expectedVersion: input.expectedVersion, body: normalizedBody });
  const result = await applyNoteUpdate(auth.userId, noteId, { ...input, tags }, hash);
  return mutationResponse(context, result);
}

export async function appendNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const input = validateAppendNoteInput(await context.req.json());
  const currentNote = await findAuthorizedNote(auth, noteId, true);
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
  await findAuthorizedNote(auth, noteId, true);
  if (input.notebookId) assertNotebookAccess(auth, input.notebookId);
  else assertUnfiledAccess(auth);
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
  await findAuthorizedNote(auth, noteId, true);
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
