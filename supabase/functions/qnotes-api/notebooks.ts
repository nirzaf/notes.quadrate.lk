import type { Context } from 'hono';
import { validateCreateNotebookInput } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { appDbClient, notebookFromRow } from '../_shared/database.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataBody(context: Context, data: unknown, status = 200): Response {
  return context.json({ data }, status as 200);
}

export async function listNotebooks(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const { data, error } = await appDbClient.from('notebooks').select('id, name, created_at, updated_at').eq('owner_id', auth.userId).order('created_at', { ascending: true }).order('name', { ascending: true });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list notebooks.');
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  return dataBody(context, { items: rows.map(notebookFromRow) });
}

export async function createNotebook(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:write');
  const input = validateCreateNotebookInput(await context.req.json());
  const { data, error } = await appDbClient.from('notebooks').insert({ owner_id: auth.userId, name: input.name }).select('id, name, created_at, updated_at').single();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'NOTEBOOK_NAME_CONFLICT', 'A notebook with that name already exists.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create the notebook.');
  }
  return dataBody(context, notebookFromRow(record(data)), 201);
}
