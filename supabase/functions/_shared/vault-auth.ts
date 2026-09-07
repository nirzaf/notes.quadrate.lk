import type { Context } from 'hono';
import { isVaultAgentToken } from '@qnotes/shared';
import { appDbClient, serviceClient } from './database.ts';
import { ApiError } from './errors.ts';
import { shouldUpdateLastUsedAt } from './auth-telemetry.ts';
import { hashVaultAgentToken } from './vault-token.ts';

export interface VaultAuthContext {
  userId: string;
  authKind: 'jwt' | 'vault-agent';
  tokenId?: string;
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  const credential = header.slice(7).trim();
  if (!credential) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  return credential;
}

export async function authenticateVaultRequest(request: Request): Promise<VaultAuthContext> {
  const credential = bearer(request);
  if (credential.startsWith('qvt_')) {
    if (!isVaultAgentToken(credential)) throw new ApiError(401, 'INVALID_TOKEN', 'The Vault agent token is invalid.');
    const tokenHash = await hashVaultAgentToken(credential);
    const { data, error } = await appDbClient.from('vault_agent_tokens').select('id, owner_id, expires_at, last_used_at, revoked_at').eq('token_hash', tokenHash).maybeSingle();
    if (error || !data) throw new ApiError(401, 'INVALID_TOKEN', 'The Vault agent token is invalid.');
    if (data.revoked_at) throw new ApiError(401, 'INVALID_TOKEN', 'The Vault agent token has been revoked.');
    if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw new ApiError(401, 'TOKEN_EXPIRED', 'The Vault agent token has expired.');
    if (shouldUpdateLastUsedAt(data.last_used_at)) {
      try {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        await appDbClient.from('vault_agent_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).or(`last_used_at.is.null,last_used_at.lt.${cutoff}`);
      } catch {
        // Last-used telemetry is best effort and never blocks Vault access.
      }
    }
    return { userId: String(data.owner_id), authKind: 'vault-agent', tokenId: String(data.id) };
  }
  if (credential.startsWith('qnt_') || credential.startsWith('qns_')) throw new ApiError(401, 'INVALID_TOKEN', 'The credential is not valid for Vault.');
  const { data, error } = await serviceClient.auth.getUser(credential);
  if (error || !data.user) throw new ApiError(401, 'INVALID_TOKEN', 'The access token is invalid.');
  return { userId: data.user.id, authKind: 'jwt' };
}

export function vaultAuthFromContext(context: Context): VaultAuthContext {
  const auth = context.get('vaultAuth');
  if (!auth || typeof auth !== 'object') throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  return auth as VaultAuthContext;
}

export function requireVaultUserJwt(auth: VaultAuthContext): void {
  if (auth.authKind !== 'jwt') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'This Vault administration route requires a Supabase user session.');
}
