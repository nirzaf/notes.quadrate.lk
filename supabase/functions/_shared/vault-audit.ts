import type { VaultAuditAction } from '@qnotes/shared';
import type { VaultAuthContext } from './vault-auth.ts';

export interface VaultAuditResource {
  ownerId: string;
  projectId?: string | null;
  environmentId?: string | null;
  secretId?: string | null;
}

export interface VaultAuditDetails {
  requestId?: string | null;
  purpose?: string | null;
}

export interface VaultAuditInsertClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error?: unknown }>;
}

async function defaultAuditClient(): Promise<VaultAuditInsertClient> {
  const { serviceClient } = await import('./database.ts');
  return serviceClient;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function resultCode(value: string): string {
  return /^[A-Za-z0-9:_-]{1,120}$/.test(value) ? value : 'rpc_failure';
}

export function buildVaultAuditFailureRow(
  auth: VaultAuthContext,
  action: VaultAuditAction,
  resource: VaultAuditResource,
  code: string,
  details: VaultAuditDetails = {},
): Record<string, unknown> {
  return {
    owner_id: auth.userId,
    actor_kind: auth.authKind === 'vault-agent' ? 'vault_agent' : 'user_jwt',
    actor_token_id: auth.tokenId ?? null,
    action,
    project_id: nullable(resource.projectId),
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
  action: VaultAuditAction,
  resource: VaultAuditResource,
  code: string,
  details: VaultAuditDetails = {},
  client?: VaultAuditInsertClient,
): Promise<void> {
  try {
    const auditClient = client ?? await defaultAuditClient();
    const row = buildVaultAuditFailureRow(auth, action, resource, code, details);
    const { error } = await auditClient.rpc('qnotes_vault_append_audit_event', {
      p_owner_id: row.owner_id,
      p_actor_kind: row.actor_kind,
      p_actor_token_id: row.actor_token_id,
      p_action: row.action,
      p_project_id: row.project_id,
      p_environment_id: row.environment_id,
      p_secret_id: row.secret_id,
      p_purpose: row.purpose,
      p_success: row.success,
      p_result_code: row.result_code,
      p_request_id: row.request_id,
      p_operation_id: row.request_id,
    });
    if (error) throw error;
  } catch {
    // Failure auditing is deliberately best effort and must not change the public response.
  }
}

export async function recordVaultAuditEvent(
  auth: VaultAuthContext,
  action: VaultAuditAction,
  resource: VaultAuditResource,
  details: VaultAuditDetails & { success?: boolean; resultCode?: string | null; operationId?: string | null } = {},
  client?: VaultAuditInsertClient,
): Promise<void> {
  const auditClient = client ?? await defaultAuditClient();
  const { error } = await auditClient.rpc('qnotes_vault_append_audit_event', {
    p_owner_id: auth.userId,
    p_actor_kind: auth.authKind === 'vault-agent' ? 'vault_agent' : 'user_jwt',
    p_actor_token_id: auth.tokenId ?? null,
    p_action: action,
    p_project_id: resource.projectId ?? null,
    p_environment_id: resource.environmentId ?? null,
    p_secret_id: resource.secretId ?? null,
    p_purpose: details.purpose ?? null,
    p_success: details.success ?? true,
    p_result_code: details.resultCode ?? 'ok',
    p_request_id: details.requestId ?? null,
    p_operation_id: details.operationId ?? details.requestId ?? null,
  });
  if (error) throw error;
}

export async function recordVaultAgentAccessDenied(
  auth: VaultAuthContext,
  action: VaultAuditAction,
  resource: VaultAuditResource,
  details: VaultAuditDetails = {},
  client?: VaultAuditInsertClient,
): Promise<void> {
  if (auth.authKind !== 'vault-agent') return;
  await recordVaultAuditFailure(auth, action, resource, 'access_denied', details, client);
}
