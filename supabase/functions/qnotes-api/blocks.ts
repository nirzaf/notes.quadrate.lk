import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, blockFromRow } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { findOwnedNote } from './notes.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataBody(context: Context, data: unknown): Response {
  return context.json({ data });
}

export async function listBlocks(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findOwnedNote(auth.userId, context.req.param('noteRef') ?? '');
  const { data, error } = await appDbClient.from('note_blocks').select('*').eq('owner_id', auth.userId).eq('note_id', note.id).order('position', { ascending: true });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list note blocks.');
  return dataBody(context, (Array.isArray(data) ? data : []).map((row) => blockFromRow(record(row))));
}

export async function getBlock(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findOwnedNote(auth.userId, context.req.param('noteRef') ?? '');
  const { data, error } = await appDbClient.from('note_blocks').select('*').eq('owner_id', auth.userId).eq('note_id', note.id).eq('block_key', context.req.param('blockKey') ?? '').maybeSingle();
  if (error || !data) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The block was not found.');
  return dataBody(context, blockFromRow(record(data)));
}
