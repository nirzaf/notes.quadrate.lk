import type { ApiTokenScope } from '@qnotes/shared';
import type { Context } from 'hono';
import { appDbClient, serviceClient } from './database.ts';
import { ApiError } from './errors.ts';
import { shouldUpdateLastUsedAt } from './auth-telemetry.ts';
import { hashPersonalToken, isPersonalToken } from './token.ts';

export interface AuthContext {
  userId: string;
  authKind: 'jwt' | 'personal';
  scopes: ApiTokenScope[] | null;
  tokenId?: string;
}

export async function authenticateRequest(request: Request): Promise<AuthContext> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  const credential = header.slice(7).trim();
  if (!credential) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  if (isPersonalToken(credential)) {
    const tokenHash = await hashPersonalToken(credential);
    const { data, error } = await appDbClient.from('api_tokens').select('id, owner_id, scopes, expires_at, last_used_at, revoked_at').eq('token_hash', tokenHash).maybeSingle();
    if (error || !data) throw new ApiError(401, 'INVALID_TOKEN', 'The personal token is invalid.');
    if (data.revoked_at) throw new ApiError(401, 'INVALID_TOKEN', 'The personal token has been revoked.');
    if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw new ApiError(401, 'TOKEN_EXPIRED', 'The personal token has expired.');
    if (shouldUpdateLastUsedAt(data.last_used_at)) {
      const telemetryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      try {
        await appDbClient
          .from('api_tokens')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', data.id)
          .or(`last_used_at.is.null,last_used_at.lt.${telemetryCutoff}`);
      } catch {
        // Last-used telemetry is best effort and must not block authentication.
      }
    }
    return { userId: data.owner_id, authKind: 'personal', scopes: data.scopes as ApiTokenScope[], tokenId: data.id };
  }
  const { data, error } = await serviceClient.auth.getUser(credential);
  if (error || !data.user) throw new ApiError(401, 'INVALID_TOKEN', 'The access token is invalid.');
  return { userId: data.user.id, authKind: 'jwt', scopes: null };
}

export function authFromContext(context: Context): AuthContext {
  const auth = context.get('auth');
  if (!auth || typeof auth !== 'object') throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  return auth as AuthContext;
}

export function requireScope(auth: AuthContext, ...required: ApiTokenScope[]): void {
  if (auth.authKind === 'jwt') return;
  if (!required.every((scope) => auth.scopes?.includes(scope))) throw new ApiError(403, 'INSUFFICIENT_SCOPE', 'The token does not have the required scope.');
}

export function requireUserJwt(auth: AuthContext): void {
  if (auth.authKind !== 'jwt') throw new ApiError(403, 'INSUFFICIENT_SCOPE', 'This route requires a Supabase user session.');
}
