import type { Context } from 'hono';
import { validateTokenInput } from '@qnotes/shared';
import { authFromContext, requireUserJwt } from '../_shared/auth.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { generatePersonalToken, hashPersonalToken, tokenPrefix } from '../_shared/token.ts';
import { fetchAllRangePages } from './vault-agent-pagination.ts';

function metadata(row: Record<string, unknown>, notebookIds?: string[]) {
  const accessRow = row.access && typeof row.access === 'object' && !Array.isArray(row.access) ? row.access as Record<string, unknown> : {};
  const mode = accessRow.mode === 'notebooks' || row.access_mode === 'notebooks' ? 'notebooks' : 'account';
  const accessNotebookIds = Array.isArray(accessRow.notebookIds) ? accessRow.notebookIds.map(String) : notebookIds ?? [];
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    access: {
      mode,
      notebookIds: mode === 'account' ? [] : accessNotebookIds,
      allowUnfiled: mode === 'account' || accessRow.allowUnfiled === true || row.allow_unfiled === true,
    },
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
  };
}

export async function listTokens(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const { data, error } = await appDbClient.from('api_tokens').select('id, name, token_prefix, scopes, access_mode, allow_unfiled, expires_at, last_used_at, revoked_at, created_at').eq('owner_id', auth.userId).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list API tokens.');
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const tokenIds = rows.map((row) => String(row.id));
  const byToken = new Map<string, string[]>();
  const grants = tokenIds.length ? await fetchAllRangePages(async (from, to) => {
    const result = await appDbClient.from('api_token_notebook_grants')
      .select('token_id, notebook_id')
      .eq('owner_id', auth.userId)
      .in('token_id', tokenIds)
      .order('token_id', { ascending: true })
      .order('notebook_id', { ascending: true })
      .range(from, to);
    if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list API token access grants.');
    return Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
  }) : [];
  for (const grant of grants) {
    const tokenId = String(grant.token_id);
    const ids = byToken.get(tokenId) ?? [];
    ids.push(String(grant.notebook_id));
    byToken.set(tokenId, ids);
  }
  return context.json({ data: rows.map((row) => metadata(row, byToken.get(String(row.id)) ?? [])) });
}

export async function createToken(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const input = validateTokenInput(await context.req.json());
  const token = generatePersonalToken();
  const hash = await hashPersonalToken(token);
  const result = await serviceClient.rpc('qnotes_create_api_token', {
    p_owner_id: auth.userId,
    p_name: input.name,
    p_token_prefix: tokenPrefix(token),
    p_token_hash: hash,
    p_scopes: input.scopes,
    p_expires_at: input.expiresAt,
    p_access_mode: input.access.mode,
    p_allow_unfiled: input.access.allowUnfiled,
    p_notebook_ids: input.access.notebookIds,
  });
  if (result.error) {
    if (result.error.message.includes('notebook_not_found')) throw new ApiError(404, 'NOTEBOOK_NOT_FOUND', 'The notebook was not found.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create API token.');
  }
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create API token.');
  return context.json({ data: { token, metadata: metadata(result.data as Record<string, unknown>) } }, 201);
}

export async function revokeToken(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const tokenId = context.req.param('tokenId');
  const { error } = await appDbClient.from('api_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', tokenId).eq('owner_id', auth.userId);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to revoke API token.');
  return context.json({ data: null });
}
