import type { VaultAction } from '@qnotes/shared';
import type { VaultAuthContext } from './vault-auth.ts';

export interface VaultAuditResource {
  ownerId: string;
  projectId: string;
  environmentId?: string | null;
  secretId?: string | null;
}

export interface VaultAuditDetails {
  requestId?: string | null;
  purpose?: string | null;
}

export interface VaultAuditInsertClient {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<unknown>;
  };
}

async function defaultAuditClient(): Promise<VaultAuditInsertClient> {
  const { appDbClient } = await import('./database.ts');
  return appDbClient;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function resultCode(value: string): string {
  return /^[A-Za-z0-9:_-]{1,120}$/.test(value) ? value : 'rpc_failure';
}

export function buildVaultAuditFailureRow(
  auth: VaultAuthContext,
  action: VaultAction,
  resource: VaultAuditResource,
  code: string,
  details: VaultAuditDetails = {},
): Record<string, unknown> {
  return {
    owner_id: auth.userId,
    actor_kind: auth.authKind === 'vault-agent' ? 'vault_agent' : 'user_jwt',
    actor_token_id: auth.tokenId ?? null,
    action,
    project_id: resource.projectId,
    environment_id: nullable(resource.environmentId),
    secret_id: nullable(resource.secretId),
    purpose: nullable(details.purpose),
    success: false,
    result_code: resultCode(code),
    request_id: nullable(details.requestId),
  };
}

export async function recordVaultAuditFailure(
  auth: VaultAuthContext,
  action: VaultAction,
  resource: VaultAuditResource,
  code: string,
  details: VaultAuditDetails = {},
  client?: VaultAuditInsertClient,
): Promise<void> {
  try {
    const auditClient = client ?? await defaultAuditClient();
    await auditClient.from('vault_audit_events').insert(buildVaultAuditFailureRow(auth, action, resource, code, details));
  } catch {
    // Failure auditing is deliberately best effort and must not change the public response.
  }
}

export async function recordVaultAgentAccessDenied(
  auth: VaultAuthContext,
  action: VaultAction,
  resource: VaultAuditResource,
  details: VaultAuditDetails = {},
  client?: VaultAuditInsertClient,
): Promise<void> {
  if (auth.authKind !== 'vault-agent') return;
  await recordVaultAuditFailure(auth, action, resource, 'access_denied', details, client);
}
