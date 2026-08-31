import type { Context } from 'hono';
import { validateLimit } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { ApiError } from '../_shared/errors.ts';
import { decodeCursor, encodeCursor, serviceClient } from '../_shared/database.ts';

export async function syncNotes(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const params = context.req.query();
  const limit = validateLimit(params.limit, 500, 200);
  let query = serviceClient.from('notes').select('id, slug, title, tags, version, updated_at, deleted_at').eq('owner_id', auth.userId);
  if (params.cursor) {
    const cursor = decodeCursor(params.cursor);
    query = query.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`);
  }
  const { data, error } = await query.order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to synchronize notes.');
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const changes = page.map((row) => ({
    noteId: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    version: Number(row.version),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  return context.json({ data: { changes, nextCursor: last ? encodeCursor({ updatedAt: String(last.updated_at), id: String(last.id) }) : params.cursor ?? null, hasMore: rows.length > limit } });
}
