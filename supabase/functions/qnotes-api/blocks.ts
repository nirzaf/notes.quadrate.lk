import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, blockFromRow } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { authPrincipal, requireCursorPolicy } from '../_shared/notebook-access.ts';
import { findAuthorizedNote } from './notes.ts';
import { asCursorInteger, asCursorString, decodeReadCursor, encodeReadCursor, fitJsonContent, parseReadRange, resolveReadRange } from './read-range.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataBody(context: Context, data: unknown): Response {
  return context.json({ data });
}

export async function listBlocks(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '');
  const { data, error } = await appDbClient.from('note_blocks').select('*').eq('owner_id', auth.userId).eq('note_id', note.id).order('position', { ascending: true });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list note blocks.');
  return dataBody(context, (Array.isArray(data) ? data : []).map((row) => blockFromRow(record(row))));
}

export async function getBlock(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '');
  const query = context.req.query();
  const rangeRequest = parseReadRange({ offset: query.offset, lineStart: query.lineStart, lineEnd: query.lineEnd, maxBytes: query.maxBytes, continuation: query.continuation });
  const { data, error } = await appDbClient.from('note_blocks').select('*').eq('owner_id', auth.userId).eq('note_id', note.id).eq('block_key', context.req.param('blockKey') ?? '').maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The block was not found.');
  const row = record(data);
  if (Object.keys(rangeRequest).length === 0) return dataBody(context, blockFromRow(row));
  const block = blockFromRow(row);
  let range = resolveReadRange(block.content, rangeRequest);
  let rangeStart = range.startOffset;
  if (rangeRequest.continuation) {
    const cursor = decodeReadCursor(rangeRequest.continuation);
    if (cursor.kind !== 'block' || cursor.blockId !== block.id || cursor.noteId !== note.id || cursor.sourceHash !== block.contentHash) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation belongs to a different block.');
    const principal = asCursorString(cursor, 'principal');
    requireCursorPolicy(auth, principal, asCursorInteger(cursor, 'policyRevision'));
    if (asCursorInteger(cursor, 'noteVersion', 1) !== note.version) throw new ApiError(409, 'NOTE_VERSION_CONFLICT', 'The block continuation is stale. Read a new block page.');
    const rangeEnd = asCursorInteger(cursor, 'rangeEnd');
    rangeStart = asCursorInteger(cursor, 'rangeStart');
    const nextOffset = asCursorInteger(cursor, 'nextOffset');
    if (rangeStart > rangeEnd || nextOffset >= rangeEnd || rangeEnd > range.endOffset || nextOffset > rangeEnd) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
    range = { ...range, startOffset: nextOffset, endOffset: rangeEnd };
  }
  return dataBody(context, fitJsonContent(block.content, range, (slice, truncated) => {
    const contentComplete = !truncated && rangeStart === 0 && range.endOffset === slice.totalBytes;
    const continuation = truncated ? encodeReadCursor({
      kind: 'block', blockId: block.id, noteId: note.id, noteVersion: note.version, sourceHash: block.contentHash,
      rangeStart, rangeEnd: range.endOffset, nextOffset: slice.endOffset, principal: authPrincipal(auth), policyRevision: auth.policyRevision,
    }) : undefined;
    return {
      ...block,
      content: slice.content,
      contentBytes: slice.endOffset - slice.startOffset,
      totalBytes: slice.totalBytes,
      offset: slice.startOffset,
      nextOffset: slice.endOffset,
      truncated: !contentComplete,
      contentComplete,
      ...(continuation ? { continuation: { cursor: continuation, sourceHash: block.contentHash, nextOffset: slice.endOffset, totalBytes: slice.totalBytes, noteVersion: note.version } } : {}),
    };
  }));
}
