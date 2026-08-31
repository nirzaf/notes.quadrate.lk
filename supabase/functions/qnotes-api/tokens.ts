import type { Context } from 'hono';
import { validateTokenInput } from '@qnotes/shared';
import { authFromContext, requireUserJwt } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { generatePersonalToken, hashPersonalToken, tokenPrefix } from '../_shared/token.ts';

function metadata(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
  };
}

export async function listTokens(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const { data, error } = await serviceClient.from('api_tokens').select('id, name, token_prefix, scopes, expires_at, last_used_at, revoked_at, created_at').eq('owner_id', auth.userId).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list API tokens.');
  return context.json({ data: (Array.isArray(data) ? data : []).map((row) => metadata(row as Record<string, unknown>)) });
}

export async function createToken(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const input = validateTokenInput(await context.req.json());
  const token = generatePersonalToken();
  const hash = await hashPersonalToken(token);
  const { data, error } = await serviceClient.from('api_tokens').insert({ owner_id: auth.userId, name: input.name, token_prefix: tokenPrefix(token), token_hash: hash, scopes: input.scopes, expires_at: input.expiresAt }).select('id, name, token_prefix, scopes, expires_at, last_used_at, revoked_at, created_at').single();
  if (error || !data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create API token.');
  return context.json({ data: { token, metadata: metadata(data as Record<string, unknown>) } }, 201);
}

export async function revokeToken(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireUserJwt(auth);
  const tokenId = context.req.param('tokenId');
  const { error } = await serviceClient.from('api_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', tokenId).eq('owner_id', auth.userId);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to revoke API token.');
  return context.json({ data: null });
}
