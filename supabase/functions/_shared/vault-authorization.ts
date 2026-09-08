import { type VaultAction } from '@qnotes/shared';
import { appDbClient } from './database.ts';
import { ApiError } from './errors.ts';
import type { VaultAuthContext } from './vault-auth.ts';
import { recordVaultAgentAccessDenied, type VaultAuditDetails, type VaultAuditResource } from './vault-audit.ts';

export type VaultResource = VaultAuditResource;

interface GrantRow {
  project_id: string;
  environment_id: string | null;
  secret_id: string | null;
  action: string;
}

function grantMatches(grant: GrantRow, action: VaultAction, resource: VaultResource): boolean {
  if (grant.action !== action || grant.project_id !== resource.projectId) return false;
  if (resource.environmentId === undefined || resource.environmentId === null) return grant.environment_id === null && grant.secret_id === null;
  if (grant.environment_id !== null && grant.environment_id !== resource.environmentId) return false;
  if (resource.secretId === undefined || resource.secretId === null) return grant.secret_id === null;
  return grant.secret_id === null || grant.secret_id === resource.secretId;
}

export async function vaultGrants(auth: VaultAuthContext, action: VaultAction): Promise<GrantRow[]> {
  if (auth.authKind === 'jwt') return [];
  if (!auth.tokenId) throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  const { data, error } = await appDbClient.from('vault_agent_grants').select('project_id, environment_id, secret_id, action').eq('owner_id', auth.userId).eq('token_id', auth.tokenId).eq('action', action);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to evaluate Vault access.');
  return Array.isArray(data) ? data as GrantRow[] : [];
}

export async function canVaultAccess(auth: VaultAuthContext, action: VaultAction, resource: VaultResource): Promise<boolean> {
  if (auth.userId !== resource.ownerId) return false;
  if (auth.authKind === 'jwt') return true;
  const grants = await vaultGrants(auth, action);
  return grants.some((grant) => grantMatches(grant, action, resource));
}

export async function requireVaultAccess(auth: VaultAuthContext, action: VaultAction, resource: VaultResource, details: VaultAuditDetails = {}): Promise<void> {
  if (!await canVaultAccess(auth, action, resource)) {
    await recordVaultAgentAccessDenied(auth, action, resource, details);
    throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  }
}

export function grantAllows(grants: GrantRow[], action: VaultAction, resource: VaultResource): boolean {
  return grants.some((grant) => grantMatches(grant, action, resource));
}
