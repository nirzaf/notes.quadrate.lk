import type { Context } from 'hono';
import { isUUID, isVaultAgentToken } from '@qnotes/shared';
import { appDbClient, serviceClient } from './database.ts';
import { ApiError } from './errors.ts';
import { shouldUpdateLastUsedAt } from './auth-telemetry.ts';
import { hashVaultAgentToken } from './vault-token.ts';

export interface VaultAuthContext {
  userId: string;
  authKind: 'jwt' | 'vault-agent';
  tokenId?: string;
  sessionId?: string;
  assuranceLevel?: 'aal1' | 'aal2';
  mfaVerifiedAt?: number | null;
}

export const VAULT_STEP_UP_MAX_AGE_SECONDS = 5 * 60;

export interface VerifiedVaultJwtClaims {
  userId: string;
  sessionId: string;
  assuranceLevel: 'aal1' | 'aal2';
  mfaVerifiedAt: number | null;
}

const MFA_METHODS = new Set(['mfa', 'totp', 'phone', 'webauthn']);

function numericClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function verifyVaultJwtClaims(value: unknown, expectedIssuer: string, nowSeconds = Math.floor(Date.now() / 1000)): VerifiedVaultJwtClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JWT claims are invalid.');
  const claims = value as Record<string, unknown>;
  const userId = claims.sub;
  const sessionId = claims.session_id;
  const audience = claims.aud;
  const issuer = claims.iss;
  const expiry = numericClaim(claims.exp);
  if (!isUUID(userId) || !isUUID(sessionId) || (audience !== 'authenticated' && !(Array.isArray(audience) && audience.includes('authenticated'))) || issuer !== expectedIssuer || claims.role !== 'authenticated' || expiry === null || expiry <= nowSeconds) {
    throw new Error('JWT claims are invalid.');
  }
  const assuranceLevel = claims.aal === 'aal2' ? 'aal2' : claims.aal === 'aal1' || claims.aal === undefined ? 'aal1' : null;
  if (!assuranceLevel) throw new Error('JWT assurance claims are invalid.');
  let mfaVerifiedAt: number | null = null;
  if (assuranceLevel === 'aal2' && Array.isArray(claims.amr)) {
    for (const item of claims.amr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const method = (item as Record<string, unknown>).method;
      const timestamp = numericClaim((item as Record<string, unknown>).timestamp);
      if (typeof method === 'string' && MFA_METHODS.has(method) && timestamp !== null && timestamp <= nowSeconds + 5 && timestamp >= nowSeconds - VAULT_STEP_UP_MAX_AGE_SECONDS) {
        mfaVerifiedAt = Math.max(mfaVerifiedAt ?? 0, timestamp);
      }
    }
  }
  return { userId, sessionId, assuranceLevel, mfaVerifiedAt };
}

function vaultJwtIssuer(): string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim().replace(/\/+$/, '');
  if (!supabaseUrl) throw new Error('SUPABASE_URL is not configured.');
  return `${supabaseUrl}/auth/v1`;
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
  let claims: VerifiedVaultJwtClaims | null = null;
  let verifiedClaims: unknown = null;
  try {
    const verified = await serviceClient.auth.getClaims(credential);
    if (!verified.error && verified.data?.claims) verifiedClaims = verified.data.claims;
  } catch {
    // getUser has already verified the identity. When the local HS256 provider cannot expose verified claims, fail closed to AAL1 so metadata remains available while every step-up route stays denied.
  }
  if (verifiedClaims) {
    try {
      claims = verifyVaultJwtClaims(verifiedClaims, vaultJwtIssuer());
    } catch {
      throw new ApiError(401, 'INVALID_TOKEN', 'The access token is invalid.');
    }
  }
  if (claims && data.user.id !== claims.userId) throw new ApiError(401, 'INVALID_TOKEN', 'The access token is invalid.');
  return claims
    ? { userId: claims.userId, authKind: 'jwt', sessionId: claims.sessionId, assuranceLevel: claims.assuranceLevel, mfaVerifiedAt: claims.mfaVerifiedAt }
    : { userId: data.user.id, authKind: 'jwt', assuranceLevel: 'aal1', mfaVerifiedAt: null };
}

export function vaultAuthFromContext(context: Context): VaultAuthContext {
  const auth = context.get('vaultAuth');
  if (!auth || typeof auth !== 'object') throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  return auth as VaultAuthContext;
}

export function requireVaultUserJwt(auth: VaultAuthContext): void {
  if (auth.authKind !== 'jwt') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'This Vault administration route requires a Supabase user session.');
}

export function requireVaultStepUp(auth: VaultAuthContext): void {
  requireVaultUserJwt(auth);
  if (auth.assuranceLevel !== 'aal2' || typeof auth.mfaVerifiedAt !== 'number' || Math.floor(Date.now() / 1000) - auth.mfaVerifiedAt > VAULT_STEP_UP_MAX_AGE_SECONDS) {
    throw new ApiError(403, 'VAULT_STEP_UP_REQUIRED', 'A verified recent second-factor step-up is required for this Vault operation.');
  }
}
