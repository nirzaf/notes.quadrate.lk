import type { Context } from 'hono';
import { hashVaultApprovalRequest, isUUID, isVaultOperationApprovalToken, parseVaultResourceReference, parseVaultSecretReference, validateCreateVaultAgentTokenInput, validateCreateVaultEnvironmentInput, validateCreateVaultProjectInput, validateCreateVaultSecretInput, validateDeleteVaultSecretInput, validateRevealVaultSecretInput, validateRevealVaultSecretsInput, validateReplaceVaultAgentGrantsInput, validateRotateVaultSecretInput, validateVaultAction, validateVaultOperationApprovalInput, type VaultAction, type VaultAgentGrant, type VaultAuditAction, type VaultResourceReference, type VaultSensitiveAction } from '@qnotes/shared';
import { assertSupabase, appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { requireVaultStepUp, vaultAuthFromContext, requireVaultUserJwt } from '../_shared/vault-auth.ts';
import { requireVaultAccess, vaultGrants } from '../_shared/vault-authorization.ts';
import { recordVaultAuditFailure } from '../_shared/vault-audit.ts';
import { hashVaultMutation, hashVaultMutationCandidates } from '../_shared/vault-token.ts';
import { generateVaultAgentToken, generateVaultApprovalToken, hashVaultAgentToken, hashVaultApprovalToken } from '../_shared/vault-token.ts';
import { fetchAllRangePages } from './vault-agent-pagination.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataBody(context: Context, data: unknown, status = 200): Response {
  return context.json({ data }, status as 200);
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function actorKind(auth: ReturnType<typeof vaultAuthFromContext>): 'user_jwt' | 'vault_agent' {
  return auth.authKind === 'vault-agent' ? 'vault_agent' : 'user_jwt';
}

function actorTokenId(auth: ReturnType<typeof vaultAuthFromContext>): string | null {
  return auth.tokenId ?? null;
}

type VaultApprovalSpec = {
  action: VaultSensitiveAction;
  projectId: string | null;
  environmentId: string | null;
  secretId: string | null;
  targetTokenId?: string | null;
  expectedVersion: number | null;
  requestHash: string;
};

type VaultMutationOperation = 'created' | 'rotated' | 'deleted';
type VaultMutationResource = { projectId: string | null; environmentId: string | null; secretId: string | null; expectedVersion: number | null };

function vaultMutationAction(operation: VaultMutationOperation): VaultAction {
  return operation === 'deleted' ? 'secret:delete' : 'secret:write';
}

async function mutationRequestHashes(...requests: unknown[]): Promise<string[]> {
  const hashes = await Promise.all(requests.map((request) => hashVaultMutationCandidates(request)));
  return [...new Set(hashes.flat())];
}

async function replayVaultMutation(
  context: Context,
  auth: ReturnType<typeof vaultAuthFromContext>,
  operation: VaultMutationOperation,
  mutationId: string,
  resource: VaultMutationResource,
  requestHashes: string[],
): Promise<Record<string, unknown> | null> {
  const result = record(assertSupabase(await serviceClient.rpc('qnotes_vault_get_mutation_receipt', {
    p_owner_id: auth.userId,
    p_mutation_id: mutationId,
    p_operation: operation,
    p_project_id: resource.projectId,
    p_environment_id: resource.environmentId,
    p_secret_id: resource.secretId,
    p_expected_version: resource.expectedVersion,
    p_request_hashes: requestHashes,
    p_actor_token_id: actorTokenId(auth),
    p_actor_kind: actorKind(auth),
    p_request_id: context.get('requestId'),
  })));
  if (result.status === 'not_found') return null;
  if (result.status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  if (result.status === 'mutation_reuse_conflict') {
    await recordVaultAuditFailure(auth, vaultMutationAction(operation), { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId: resource.secretId }, 'mutation_reuse_conflict', { requestId: context.get('requestId') });
    throw new ApiError(409, 'VAULT_MUTATION_REUSE', 'The mutation ID was already used for a different Vault request.');
  }
  if (result.status === 'expired') {
    await recordVaultAuditFailure(auth, vaultMutationAction(operation), { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId: resource.secretId }, 'mutation_receipt_expired', { requestId: context.get('requestId') });
    throw new ApiError(409, 'VAULT_MUTATION_EXPIRED', 'The Vault mutation receipt has expired; use a new mutation ID.', { retentionExpiresAt: result.retentionExpiresAt });
  }
  if (result.status !== 'idempotent') throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault mutation receipt is invalid.');
  return result;
}

export async function statusVaultMutation(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const mutationId = context.req.param('mutationId') ?? '';
  if (!isUUID(mutationId)) throw new ApiError(422, 'VALIDATION_ERROR', 'mutationId must be a valid UUID.');
  const result = record(assertSupabase(await serviceClient.rpc('qnotes_vault_get_mutation_receipt', {
    p_owner_id: auth.userId,
    p_mutation_id: mutationId,
    p_operation: null,
    p_project_id: null,
    p_environment_id: null,
    p_secret_id: null,
    p_expected_version: null,
    p_request_hashes: null,
    p_actor_token_id: actorTokenId(auth),
    p_actor_kind: actorKind(auth),
    p_request_id: context.get('requestId'),
  })));
  if (result.status === 'not_found') throw new ApiError(404, 'VAULT_MUTATION_NOT_FOUND', 'The Vault mutation receipt was not found.');
  if (result.status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  if (result.status !== 'complete' && result.status !== 'expired') throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault mutation receipt is invalid.');
  return dataBody(context, result);
}

async function requireVaultOperationApproval(context: Context, auth: ReturnType<typeof vaultAuthFromContext>, spec: VaultApprovalSpec): Promise<void> {
  if (auth.authKind === 'vault-agent') return;
  requireVaultStepUp(auth);
  if (!auth.sessionId) throw new ApiError(403, 'VAULT_STEP_UP_REQUIRED', 'The authenticated session cannot be bound to a Vault approval.');
  const approvalToken = context.req.header('x-vault-approval') ?? '';
  const requestHash = context.req.header('x-vault-request-hash') ?? '';
  const resource = { ownerId: auth.userId, projectId: spec.projectId, environmentId: spec.environmentId, secretId: spec.secretId, targetTokenId: spec.targetTokenId ?? null };
  if (!isVaultOperationApprovalToken(approvalToken) || requestHash !== spec.requestHash) {
    await recordVaultAuditFailure(auth, 'access:denied', resource, 'approval_required', { requestId: context.get('requestId') });
    throw new ApiError(403, 'VAULT_APPROVAL_REQUIRED', 'A single-use Vault operation approval is required.');
  }
  const approvalHash = await hashVaultApprovalToken(approvalToken);
  const result = record(assertSupabase(await serviceClient.rpc('qnotes_consume_vault_operation_approval', {
    p_owner_id: auth.userId,
    p_session_id: auth.sessionId,
    p_action: spec.action,
    p_project_id: spec.projectId,
    p_environment_id: spec.environmentId,
    p_secret_id: spec.secretId,
    p_expected_version: spec.expectedVersion,
    p_request_hash: spec.requestHash,
    p_approval_hash: approvalHash,
    p_request_id: context.get('requestId'),
  })));
  if (result.status !== 'ok') {
    await recordVaultAuditFailure(auth, 'access:denied', resource, `approval_${String(result.status ?? 'invalid')}`, { requestId: context.get('requestId') });
    throw new ApiError(403, 'VAULT_APPROVAL_INVALID', 'The Vault operation approval is invalid, expired, or already used.');
  }
}

export async function issueVaultOperationApproval(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultStepUp(auth);
  if (!auth.sessionId) throw new ApiError(403, 'VAULT_STEP_UP_REQUIRED', 'The authenticated session cannot be bound to a Vault approval.');
  const input = validateVaultOperationApprovalInput(await context.req.json());
  const approvalToken = generateVaultApprovalToken();
  const result = record(assertSupabase(await serviceClient.rpc('qnotes_issue_vault_operation_approval', {
    p_owner_id: auth.userId,
    p_session_id: auth.sessionId,
    p_action: input.action,
    p_project_id: input.projectId,
    p_environment_id: input.environmentId,
    p_secret_id: input.secretId,
    p_expected_version: input.expectedVersion,
    p_request_hash: input.requestHash,
    p_approval_hash: await hashVaultApprovalToken(approvalToken),
    p_request_id: context.get('requestId'),
  })));
  if (result.status !== 'ok' || typeof result.expiresAt !== 'string') throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to issue a Vault operation approval.');
  return noStore(dataBody(context, { approvalToken, expiresAt: result.expiresAt }));
}

function projectMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: row.description ? String(row.description) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at ? String(row.archived_at) : null };
}

function environmentMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), projectId: String(row.project_id), slug: String(row.slug), name: String(row.name), description: row.description ? String(row.description) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at ? String(row.archived_at) : null };
}

function secretMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), projectId: String(row.project_id), environmentId: String(row.environment_id), name: String(row.name), description: row.description ? String(row.description) : null, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), rotatedAt: row.rotated_at ? String(row.rotated_at) : null, deletedAt: row.deleted_at ? String(row.deleted_at) : null };
}

type VaultGrantResourceNames = Pick<VaultAgentGrant, 'projectName' | 'environmentName' | 'secretName'>;
type VaultGrantMetadataTable = 'vault_projects' | 'vault_environments' | 'vault_secrets';

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function grantMetadata(row: Record<string, unknown>, names: VaultGrantResourceNames = {}): VaultAgentGrant {
  const grant: VaultAgentGrant = {
    id: row.id ? String(row.id) : undefined,
    projectId: String(row.project_id ?? row.projectId),
    environmentId: row.environment_id === null || row.environment_id === undefined ? row.environmentId === null || row.environmentId === undefined ? null : String(row.environmentId) : String(row.environment_id),
    secretId: row.secret_id === null || row.secret_id === undefined ? row.secretId === null || row.secretId === undefined ? null : String(row.secretId) : String(row.secret_id),
    action: String(row.action) as VaultAction,
    createdAt: row.created_at ? String(row.created_at) : row.createdAt ? String(row.createdAt) : undefined,
  };
  const projectName = firstString(names.projectName, row.projectName, row.project_name);
  const environmentName = firstString(names.environmentName, row.environmentName, row.environment_name);
  const secretName = firstString(names.secretName, row.secretName, row.secret_name);
  if (projectName !== undefined) grant.projectName = projectName;
  if (environmentName !== undefined) grant.environmentName = environmentName;
  if (secretName !== undefined) grant.secretName = secretName;
  return grant;
}

function tokenMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), name: String(row.name), tokenPrefix: String(row.token_prefix ?? row.tokenPrefix), expiresAt: row.expires_at ? String(row.expires_at) : row.expiresAt ? String(row.expiresAt) : null, lastUsedAt: row.last_used_at ? String(row.last_used_at) : row.lastUsedAt ? String(row.lastUsedAt) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : row.revokedAt ? String(row.revokedAt) : null, createdAt: String(row.created_at ?? row.createdAt), grants: Array.isArray(row.grants) ? row.grants.map((grant) => grantMetadata(record(grant))) : [] };
}

function rowId(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === 'string' && value ? value : null;
}

async function loadVaultGrantResourceNames(ownerId: string, table: VaultGrantMetadataTable, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const { data, error } = await appDbClient.from(table).select('id, name').eq('owner_id', ownerId).in('id', chunk);
    if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault agent grant resources.');
    for (const row of Array.isArray(data) ? data : []) {
      const item = record(row);
      const id = rowId(item, 'id');
      const name = rowId(item, 'name');
      if (id && name) names.set(id, name);
    }
  }
  return names;
}

async function vaultGrantResourceNames(ownerId: string, rows: Record<string, unknown>[]): Promise<{
  projectNames: Map<string, string>;
  environmentNames: Map<string, string>;
  secretNames: Map<string, string>;
}> {
  const projectIds = [...new Set(rows.map((row) => rowId(row, 'project_id')).filter((id): id is string => Boolean(id)))];
  const environmentIds = [...new Set(rows.map((row) => rowId(row, 'environment_id')).filter((id): id is string => Boolean(id)))];
  const secretIds = [...new Set(rows.map((row) => rowId(row, 'secret_id')).filter((id): id is string => Boolean(id)))];
  const [projectNames, environmentNames, secretNames] = await Promise.all([
    loadVaultGrantResourceNames(ownerId, 'vault_projects', projectIds),
    loadVaultGrantResourceNames(ownerId, 'vault_environments', environmentIds),
    loadVaultGrantResourceNames(ownerId, 'vault_secrets', secretIds),
  ]);
  return { projectNames, environmentNames, secretNames };
}

async function findProject(ownerId: string, reference: string, activeOnly = true): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_projects').select('*').eq('owner_id', ownerId).limit(1);
  const parsed = parseVaultResourceReference(reference, 'project reference', 80);
  query = parsed.id ? query.eq('id', parsed.id) : query.eq('slug', parsed.slug!);
  if (activeOnly) query = query.is('archived_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_PROJECT_NOT_FOUND', 'The Vault project was not found.');
  return record(data);
}

async function findEnvironment(ownerId: string, projectId: string, reference: string, activeOnly = true): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_environments').select('*').eq('owner_id', ownerId).eq('project_id', projectId).limit(1);
  const parsed = parseVaultResourceReference(reference, 'environment reference', 80);
  query = parsed.id ? query.eq('id', parsed.id) : query.eq('slug', parsed.slug!);
  if (activeOnly) query = query.is('archived_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_ENVIRONMENT_NOT_FOUND', 'The Vault environment was not found.');
  return record(data);
}

async function findEnvironmentById(ownerId: string, reference: string, activeOnly = true): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_environments').select('*').eq('owner_id', ownerId).eq('id', reference).limit(1);
  if (activeOnly) query = query.is('archived_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_ENVIRONMENT_NOT_FOUND', 'The Vault environment was not found.');
  return record(data);
}

async function findSecret(ownerId: string, secretId: string, includeDeleted = false): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_secrets').select('*').eq('owner_id', ownerId).eq('id', secretId).limit(1);
  if (!includeDeleted) query = query.is('deleted_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
  return record(data);
}

type ExactVaultResourceInput = {
  project?: string;
  environment?: string;
  environmentId?: string;
  secretName?: string;
  secretId?: string;
};

function resolveAction(value: unknown): VaultAction {
  return validateVaultAction(value);
}

function resolverStatusError(status: unknown, resource: 'environment' | 'secret'): never {
  if (status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  if (status === 'invalid_action' || status === 'invalid_reference') throw new ApiError(422, 'VALIDATION_ERROR', 'The Vault resource reference is invalid.');
  if (status === 'project_not_found') throw new ApiError(404, 'VAULT_PROJECT_NOT_FOUND', 'The Vault project was not found.');
  if (status === 'environment_not_found') throw new ApiError(404, 'VAULT_ENVIRONMENT_NOT_FOUND', 'The Vault environment was not found.');
  if (status === 'not_found') throw new ApiError(404, resource === 'secret' ? 'VAULT_SECRET_NOT_FOUND' : 'VAULT_ENVIRONMENT_NOT_FOUND', `The Vault ${resource} was not found.`);
  throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to resolve the Vault resource.');
}

async function resolveVaultResource(
  context: Context,
  auth: ReturnType<typeof vaultAuthFromContext>,
  action: VaultAction,
  input: ExactVaultResourceInput,
  resource: 'environment' | 'secret',
): Promise<VaultResourceReference> {
  const project = input.project === undefined ? {} : parseVaultResourceReference(input.project, 'project reference', 80);
  const environment = input.environment === undefined ? {} : parseVaultResourceReference(input.environment, 'environment reference', 80);
  const secret: { id?: string; name?: string } = input.secretId === undefined && input.secretName === undefined
    ? {}
    : input.secretId === undefined ? parseVaultSecretReference(input.secretName) : { id: input.secretId };
  if (input.environmentId !== undefined && !isUUID(input.environmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'environmentId must be a valid UUID.');
  if (secret.id !== undefined && !isUUID(secret.id)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  const payload = record(assertSupabase(await serviceClient.rpc('qnotes_vault_resolve_resource', {
    p_owner_id: auth.userId,
    p_actor_token_id: actorTokenId(auth),
    p_actor_kind: actorKind(auth),
    p_action: action,
    p_project_id: project.id ?? null,
    p_project_slug: project.slug ?? null,
    p_environment_id: input.environmentId ?? environment.id ?? null,
    p_environment_slug: environment.slug ?? null,
    p_secret_id: secret.id ?? null,
    p_secret_name: secret.name ?? null,
    p_request_id: context.get('requestId'),
  })));
  if (payload.status !== 'ok') resolverStatusError(payload.status, resource);
  const reference = record(payload.resource);
  if (!isUUID(reference.projectId) || !isUUID(reference.environmentId) || (reference.secretId !== null && !isUUID(reference.secretId))) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault resource resolver returned an invalid reference.');
  return { projectId: reference.projectId, environmentId: reference.environmentId, secretId: reference.secretId as string | null };
}

function validateResolveEnvironmentInput(value: unknown): { project: string; environment: string; action: VaultAction } {
  const input = record(value);
  const project = typeof input.project === 'string' ? input.project : '';
  const environment = typeof input.environment === 'string' ? input.environment : '';
  if (!project || !environment) throw new ApiError(422, 'VALIDATION_ERROR', 'project and environment are required.');
  const action = resolveAction(input.action);
  if (action !== 'metadata:read' && action !== 'secret:write') throw new ApiError(422, 'VALIDATION_ERROR', 'The requested environment action is invalid.');
  return { project, environment, action };
}

function validateResolveSecretInput(value: unknown): { input: ExactVaultResourceInput; action: VaultAction } {
  const input = record(value);
  const action = resolveAction(input.action);
  if (typeof input.secretId === 'string') {
    if (Object.hasOwn(input, 'project') || Object.hasOwn(input, 'environment') || Object.hasOwn(input, 'name')) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId cannot be combined with a selector.');
    if (!isUUID(input.secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
    return { input: { secretId: input.secretId }, action };
  }
  if (typeof input.project !== 'string' || typeof input.environment !== 'string' || typeof input.name !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'project, environment, and name are required.');
  return { input: { project: input.project, environment: input.environment, secretName: input.name }, action };
}

async function mapVaultMutation(
  context: Context,
  auth: ReturnType<typeof vaultAuthFromContext>,
  value: unknown,
  action: 'create' | 'rotate' | 'delete',
  resource: { ownerId: string; projectId: string | null; environmentId: string | null; secretId: string | null },
) {
  const result = record(value);
  const status = result.status;
  const auditAction: VaultAction = action === 'delete' ? 'secret:delete' : 'secret:write';
  const failureCode = typeof status === 'string' ? status : 'rpc_failure';
  if (status === 'ok' || status === 'idempotent') {
    const secret = record(result.secret);
    if (!secret.id) {
      await recordVaultAuditFailure(auth, auditAction, resource, 'invalid_response', { requestId: context.get('requestId') });
      throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault mutation returned an invalid result.');
    }
    return secretMetadata({ id: secret.id, project_id: secret.projectId, environment_id: secret.environmentId, name: secret.name, description: secret.description, version: secret.version, created_at: secret.createdAt, updated_at: secret.updatedAt, rotated_at: secret.rotatedAt, deleted_at: secret.deletedAt });
  }
  if (status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
  await recordVaultAuditFailure(auth, auditAction, resource, failureCode, { requestId: context.get('requestId') });
  if (status === 'project_not_found') throw new ApiError(404, 'VAULT_PROJECT_NOT_FOUND', 'The Vault project was not found.');
  if (status === 'environment_not_found') throw new ApiError(404, 'VAULT_ENVIRONMENT_NOT_FOUND', 'The Vault environment was not found.');
  if (status === 'not_found') throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
  if (status === 'secret_conflict') throw new ApiError(409, 'VAULT_SECRET_CONFLICT', 'An active Vault secret with that name already exists.');
  if (status === 'mutation_reuse_conflict') throw new ApiError(409, 'VAULT_MUTATION_REUSE', 'The mutation ID was already used for a different Vault request.');
  if (status === 'version_conflict') throw new ApiError(409, 'VAULT_VERSION_CONFLICT', 'The Vault secret was changed by another operation.', { currentVersion: result.currentVersion });
  if (status === 'secret_too_large') throw new ApiError(413, 'VAULT_SECRET_TOO_LARGE', 'The Vault secret value is too large.');
  if (status === 'invalid_name') throw new ApiError(422, 'VALIDATION_ERROR', 'The Vault secret name is invalid.');
  throw new ApiError(500, 'INTERNAL_ERROR', `Unable to ${action} the Vault secret.`);
}

async function revealById(context: Context, auth: ReturnType<typeof vaultAuthFromContext>, secret: Record<string, unknown>, purpose: string): Promise<Record<string, unknown>> {
  const resource = { ownerId: auth.userId, projectId: String(secret.project_id), environmentId: String(secret.environment_id), secretId: String(secret.id) };
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_reveal_secret', {
    p_owner_id: auth.userId,
    p_secret_id: String(secret.id),
    p_actor_token_id: actorTokenId(auth),
    p_purpose: purpose,
    p_request_id: context.get('requestId'),
    p_actor_kind: actorKind(auth),
  }));
  const payload = record(result);
  if (payload.status !== 'ok' || !record(payload.secret)) {
    if (payload.status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
    await recordVaultAuditFailure(auth, 'secret:reveal', resource, typeof payload.status === 'string' ? payload.status : 'invalid_response', { requestId: context.get('requestId'), purpose });
    if (payload.status === 'not_found') throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
    if (payload.status === 'vault_missing') throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault value is unavailable.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault reveal failed.');
  }
  return record(payload.secret);
}

export async function listVaultProjects(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const projectIds = auth.authKind === 'vault-agent'
    ? [...new Set((await vaultGrants(auth, 'metadata:read')).map((grant) => grant.project_id))]
    : null;
  if (projectIds && projectIds.length === 0) return dataBody(context, []);
  const rows = await fetchAllRangePages(async (from, to) => {
    let query = appDbClient.from('vault_projects').select('*').eq('owner_id', auth.userId).is('archived_at', null);
    if (projectIds) query = query.in('id', projectIds);
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to);
    if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault projects.');
    return Array.isArray(data) ? data.map((row) => record(row)) : [];
  });
  return dataBody(context, rows.map(projectMetadata));
}

export async function resolveVaultEnvironment(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateResolveEnvironmentInput(await context.req.json());
  return dataBody(context, await resolveVaultResource(context, auth, input.action, input, 'environment'));
}

export async function resolveVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const validation = validateResolveSecretInput(await context.req.json());
  const resource = await resolveVaultResource(context, auth, validation.action, validation.input, 'secret');
  if (!resource.secretId) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault secret resolver returned an invalid reference.');
  return dataBody(context, resource);
}

export async function createVaultProject(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const input = validateCreateVaultProjectInput(await context.req.json());
  const { data, error } = await appDbClient.from('vault_projects').insert({ owner_id: auth.userId, slug: input.slug, name: input.name, description: input.description ?? null }).select('*').single();
  if (error || !data) {
    if (error?.code === '23505') throw new ApiError(409, 'VAULT_PROJECT_CONFLICT', 'An active Vault project with that slug already exists.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create Vault project.');
  }
  return dataBody(context, projectMetadata(record(data)), 201);
}

export async function listVaultEnvironments(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const project = await findProject(auth.userId, context.req.param('projectRef') ?? '');
  const projectId = String(project.id);
  const grants = auth.authKind === 'vault-agent' ? await vaultGrants(auth, 'metadata:read') : null;
  const projectWide = grants?.some((grant) => grant.project_id === projectId && grant.environment_id === null && grant.secret_id === null) ?? true;
  const environmentIds = grants
    ? [...new Set(grants.filter((grant) => grant.project_id === projectId && grant.environment_id !== null && grant.secret_id === null).map((grant) => grant.environment_id as string))]
    : null;
  if (grants && !projectWide && environmentIds?.length === 0) return dataBody(context, []);
  const rows = await fetchAllRangePages(async (from, to) => {
    let query = appDbClient.from('vault_environments').select('*').eq('owner_id', auth.userId).eq('project_id', projectId).is('archived_at', null);
    if (grants && !projectWide) query = query.in('id', environmentIds ?? []);
    const { data, error } = await query.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
    if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault environments.');
    return Array.isArray(data) ? data.map((row) => record(row)) : [];
  });
  return dataBody(context, rows.map(environmentMetadata));
}

export async function createVaultEnvironment(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const project = await findProject(auth.userId, context.req.param('projectRef') ?? '');
  const input = validateCreateVaultEnvironmentInput({ ...(await context.req.json()), projectId: project.id });
  const { data, error } = await appDbClient.from('vault_environments').insert({ owner_id: auth.userId, project_id: project.id, slug: input.slug, name: input.name, description: input.description ?? null }).select('*').single();
  if (error || !data) {
    if (error?.code === '23505') throw new ApiError(409, 'VAULT_ENVIRONMENT_CONFLICT', 'An active Vault environment with that slug already exists.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create Vault environment.');
  }
  return dataBody(context, environmentMetadata(record(data)), 201);
}

async function listSecretsForEnvironment(context: Context, auth: ReturnType<typeof vaultAuthFromContext>, projectId: string, environmentId: string): Promise<Response> {
  const grants = auth.authKind === 'vault-agent' ? await vaultGrants(auth, 'metadata:read') : null;
  const projectWide = grants?.some((grant) => grant.project_id === projectId && grant.environment_id === null && grant.secret_id === null) ?? true;
  const environmentWide = grants?.some((grant) => grant.project_id === projectId && grant.environment_id === environmentId && grant.secret_id === null) ?? true;
  const secretIds = grants
    ? [...new Set(grants.filter((grant) => grant.project_id === projectId && grant.environment_id === environmentId && grant.secret_id !== null).map((grant) => grant.secret_id as string))]
    : null;
  if (grants && !projectWide && !environmentWide && secretIds?.length === 0) return dataBody(context, []);
  const rows = await fetchAllRangePages(async (from, to) => {
    let query = appDbClient.from('vault_secrets').select('*').eq('owner_id', auth.userId).eq('project_id', projectId).eq('environment_id', environmentId).is('deleted_at', null);
    if (grants && !projectWide && !environmentWide) query = query.in('id', secretIds ?? []);
    const { data, error } = await query.order('name', { ascending: true }).order('id', { ascending: true }).range(from, to);
    if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault secrets.');
    return Array.isArray(data) ? data.map((row) => record(row)) : [];
  });
  return dataBody(context, rows.map(secretMetadata));
}

export async function listVaultSecrets(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const environment = await findEnvironmentById(auth.userId, context.req.param('environmentId') ?? '');
  return listSecretsForEnvironment(context, auth, String(environment.project_id), String(environment.id));
}

export async function listVaultSecretsBySelector(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const project = await findProject(auth.userId, context.req.param('projectRef') ?? '');
  const environment = await findEnvironment(auth.userId, String(project.id), context.req.param('environmentRef') ?? '');
  return listSecretsForEnvironment(context, auth, String(project.id), String(environment.id));
}

async function createVaultSecretForEnvironment(
  context: Context,
  project: Record<string, unknown>,
  environment: Record<string, unknown>,
  input: ReturnType<typeof validateCreateVaultSecretInput>,
): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const approvalRequest = { operation: 'created', projectId: project.id, environmentId: environment.id, name: input.name, description: input.description ?? null, value: input.value, mutationId: input.mutationId };
  await requireVaultOperationApproval(context, auth, { action: 'secret:write', projectId: String(project.id), environmentId: String(environment.id), secretId: null, expectedVersion: null, requestHash: await hashVaultApprovalRequest(approvalRequest) });
  await requireVaultAccess(auth, 'secret:write', { ownerId: auth.userId, projectId: String(project.id), environmentId: String(environment.id), secretId: null }, { requestId: context.get('requestId') });
  const request = { operation: 'created', projectId: project.id, environmentId: environment.id, name: input.name, description: input.description ?? null, value: input.value };
  const requestHash = await hashVaultMutation(request);
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_create_secret', { p_owner_id: auth.userId, p_project_id: project.id, p_environment_id: environment.id, p_name: input.name, p_description: input.description ?? null, p_value: input.value, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, await mapVaultMutation(context, auth, result, 'create', { ownerId: auth.userId, projectId: String(project.id), environmentId: String(environment.id), secretId: null }), record(result).status === 'idempotent' ? 200 : 201);
}

export async function createVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const environment = await findEnvironmentById(auth.userId, context.req.param('environmentId') ?? '');
  const body = record(await context.req.json());
  const bodyProjectId = typeof body.projectId === 'string' && isUUID(body.projectId) ? body.projectId : null;
  const bodyEnvironmentId = typeof body.environmentId === 'string' && isUUID(body.environmentId) ? body.environmentId : null;
  if (bodyProjectId && bodyEnvironmentId && (bodyProjectId !== String(environment.project_id) || bodyEnvironmentId !== String(environment.id))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'projectId and environmentId must match the route resource.');
  }
  const resource = await resolveVaultResource(context, auth, 'secret:write', { environmentId: context.req.param('environmentId') ?? '' }, 'environment');
  const project = await findProject(auth.userId, String(environment.project_id));
  const input = validateCreateVaultSecretInput({ ...body, projectId: resource.projectId, environmentId: resource.environmentId });
  const request = { operation: 'created', projectId: resource.projectId, environmentId: resource.environmentId, name: input.name, description: input.description ?? null, value: input.value };
  const replay = await replayVaultMutation(context, auth, 'created', input.mutationId, { projectId: resource.projectId, environmentId: resource.environmentId, secretId: null, expectedVersion: null }, await mutationRequestHashes(request));
  if (replay) return dataBody(context, await mapVaultMutation(context, auth, replay, 'create', { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId: null }));
  return createVaultSecretForEnvironment(context, project, environment, input);
}

export async function createVaultSecretBySelector(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const resource = await resolveVaultResource(context, auth, 'secret:write', { project: context.req.param('projectRef') ?? '', environment: context.req.param('environmentRef') ?? '' }, 'environment');
  const input = validateCreateVaultSecretInput({ ...(await context.req.json()), projectId: resource.projectId, environmentId: resource.environmentId });
  const request = { operation: 'created', projectId: resource.projectId, environmentId: resource.environmentId, name: input.name, description: input.description ?? null, value: input.value };
  const replay = await replayVaultMutation(context, auth, 'created', input.mutationId, { projectId: resource.projectId, environmentId: resource.environmentId, secretId: null, expectedVersion: null }, await mutationRequestHashes(request));
  if (replay) return dataBody(context, await mapVaultMutation(context, auth, replay, 'create', { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId: null }));
  return createVaultSecretForEnvironment(context, { id: resource.projectId }, { id: resource.environmentId }, input);
}

export async function getVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secretId = context.req.param('secretId') ?? '';
  if (!isUUID(secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  await resolveVaultResource(context, auth, 'metadata:read', { secretId }, 'secret');
  const secret = await findSecret(auth.userId, secretId);
  return dataBody(context, secretMetadata(secret));
}

export async function rotateVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secretId = context.req.param('secretId') ?? '';
  if (!isUUID(secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  const input = validateRotateVaultSecretInput(await context.req.json());
  const legacyRequest = { operation: 'rotated', secretId, value: input.value, description: input.description ?? null };
  const request = { ...legacyRequest, expectedVersion: input.expectedVersion };
  const requestHash = await hashVaultMutation(request);
  const legacyRequestHash = await hashVaultMutation(legacyRequest);
  const replay = await replayVaultMutation(context, auth, 'rotated', input.mutationId, { projectId: null, environmentId: null, secretId, expectedVersion: input.expectedVersion }, await mutationRequestHashes(request, legacyRequest));
  if (replay) return dataBody(context, await mapVaultMutation(context, auth, replay, 'rotate', { ownerId: auth.userId, projectId: null, environmentId: null, secretId }));
  const resource = await resolveVaultResource(context, auth, 'secret:write', { secretId }, 'secret');
  const approvalRequest = { operation: 'rotated', secretId, value: input.value, description: input.description ?? null, expectedVersion: input.expectedVersion, mutationId: input.mutationId };
  await requireVaultOperationApproval(context, auth, { action: 'secret:write', projectId: resource.projectId, environmentId: resource.environmentId, secretId, expectedVersion: input.expectedVersion, requestHash: await hashVaultApprovalRequest(approvalRequest) });
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_rotate_secret', { p_owner_id: auth.userId, p_secret_id: secretId, p_value: input.value, p_description: input.description ?? null, p_expected_version: input.expectedVersion, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_legacy_request_hash: legacyRequestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, await mapVaultMutation(context, auth, result, 'rotate', { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId }));
}

export async function deleteVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secretId = context.req.param('secretId') ?? '';
  if (!isUUID(secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  const input = validateDeleteVaultSecretInput(await context.req.json());
  const request = { operation: 'deleted', secretId, expectedVersion: input.expectedVersion };
  const requestHash = await hashVaultMutation(request);
  const replay = await replayVaultMutation(context, auth, 'deleted', input.mutationId, { projectId: null, environmentId: null, secretId, expectedVersion: input.expectedVersion }, await mutationRequestHashes(request));
  if (replay) return dataBody(context, await mapVaultMutation(context, auth, replay, 'delete', { ownerId: auth.userId, projectId: null, environmentId: null, secretId }));
  const resource = await resolveVaultResource(context, auth, 'secret:delete', { secretId }, 'secret');
  const approvalRequest = { operation: 'deleted', secretId, expectedVersion: input.expectedVersion, mutationId: input.mutationId };
  await requireVaultOperationApproval(context, auth, { action: 'secret:delete', projectId: resource.projectId, environmentId: resource.environmentId, secretId, expectedVersion: input.expectedVersion, requestHash: await hashVaultApprovalRequest(approvalRequest) });
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_delete_secret', { p_owner_id: auth.userId, p_secret_id: secretId, p_expected_version: input.expectedVersion, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, await mapVaultMutation(context, auth, result, 'delete', { ownerId: auth.userId, projectId: resource.projectId, environmentId: resource.environmentId, secretId }));
}

export async function revealVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateRevealVaultSecretInput(await context.req.json());
  const resource = await resolveVaultResource(context, auth, 'secret:reveal', { project: input.project, environment: input.environment, secretName: input.name }, 'secret');
  if (!resource.secretId) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault secret resolver returned an invalid reference.');
  const secret = { id: resource.secretId, project_id: resource.projectId, environment_id: resource.environmentId };
  const approvalRequest = { operation: 'revealed', project: input.project, environment: input.environment, name: input.name, purpose: input.purpose };
  await requireVaultOperationApproval(context, auth, { action: 'secret:reveal', projectId: resource.projectId, environmentId: resource.environmentId, secretId: resource.secretId, expectedVersion: null, requestHash: await hashVaultApprovalRequest(approvalRequest) });
  return noStore(dataBody(context, await revealById(context, auth, secret, input.purpose)));
}

export async function revealVaultSecrets(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateRevealVaultSecretsInput(await context.req.json());
  await requireVaultOperationApproval(context, auth, { action: 'secret:reveal', projectId: null, environmentId: null, secretId: null, expectedVersion: null, requestHash: await hashVaultApprovalRequest({ operation: 'revealed-batch', selectors: input.secrets, purpose: input.purpose }) });
  const resolved: Array<{ secret: Record<string, unknown> }> = [];
  for (const selector of input.secrets) {
    const resource = await resolveVaultResource(context, auth, 'secret:reveal', { project: selector.project, environment: selector.environment, secretName: selector.name }, 'secret');
    if (!resource.secretId) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault secret resolver returned an invalid reference.');
    resolved.push({ secret: { id: resource.secretId, project_id: resource.projectId, environment_id: resource.environmentId } });
  }

  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_reveal_secrets', {
    p_owner_id: auth.userId,
    p_selectors: resolved.map(({ secret }) => ({ projectId: String(secret.project_id), environmentId: String(secret.environment_id), secretId: String(secret.id) })),
    p_actor_token_id: actorTokenId(auth),
    p_purpose: input.purpose,
    p_request_id: context.get('requestId'),
    p_actor_kind: actorKind(auth),
  }));
  const payload = record(result);
  if (payload.status !== 'ok' || !Array.isArray(payload.items)) {
    if (payload.status === 'access_denied') throw new ApiError(403, 'VAULT_ACCESS_DENIED', 'Vault access is denied.');
    if (payload.status === 'not_found') throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
    if (payload.status === 'vault_missing') throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault value is unavailable.');
    if (payload.status === 'batch_too_large') throw new ApiError(413, 'VAULT_SECRET_TOO_LARGE', 'The combined Vault reveal is too large.');
    if (payload.status === 'invalid_selectors') throw new ApiError(422, 'VALIDATION_ERROR', 'The Vault selectors are invalid.');
    throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault reveal failed.');
  }
  return noStore(dataBody(context, { items: payload.items }));
}

export async function listVaultAgentTokens(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const { data, error } = await appDbClient.from('vault_agent_tokens').select('id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at').eq('owner_id', auth.userId).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault agent tokens.');
  const tokenRows = Array.isArray(data) ? data.map(record) : [];
  const tokenIds = tokenRows.map((row) => String(row.id));
  const grantsByToken = new Map<string, VaultAgentGrant[]>();
  if (tokenIds.length) {
    const grantRows = await fetchAllRangePages(async (from, to) => {
      const grantResult = await appDbClient.from('vault_agent_grants').select('id, token_id, project_id, environment_id, secret_id, action, created_at').eq('owner_id', auth.userId).in('token_id', tokenIds).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
      if (grantResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault agent grants.');
      return Array.isArray(grantResult.data) ? grantResult.data.map((row) => record(row)) : [];
    });
    const names = await vaultGrantResourceNames(auth.userId, grantRows);
    for (const row of grantRows) {
      const item = record(row);
      const tokenId = String(item.token_id);
      const grants = grantsByToken.get(tokenId) ?? [];
      grants.push(grantMetadata(item, {
        projectName: names.projectNames.get(String(item.project_id)),
        environmentName: names.environmentNames.get(String(item.environment_id)),
        secretName: names.secretNames.get(String(item.secret_id)),
      }));
      grantsByToken.set(tokenId, grants);
    }
  }
  return dataBody(context, tokenRows.map((row) => tokenMetadata({ ...row, grants: grantsByToken.get(String(row.id)) ?? [] })));
}

export async function createVaultAgentToken(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const input = validateCreateVaultAgentTokenInput(await context.req.json());
  const approvalRequest = { operation: 'token-issued', name: input.name, expiresAt: input.expiresAt, grants: input.grants };
  await requireVaultOperationApproval(context, auth, { action: 'token:issue', projectId: null, environmentId: null, secretId: null, expectedVersion: null, requestHash: await hashVaultApprovalRequest(approvalRequest) });
  const token = generateVaultAgentToken();
  const tokenHash = await hashVaultAgentToken(token);
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_vault_agent_token', { p_owner_id: auth.userId, p_name: input.name, p_token_prefix: token.slice(0, 12), p_token_hash: tokenHash, p_expires_at: input.expiresAt, p_grants: input.grants, p_request_id: context.get('requestId') }));
  const payload = record(result);
  if (!payload.id || !Array.isArray(payload.grants)) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create Vault agent token.');
  return noStore(dataBody(context, { token, metadata: tokenMetadata(payload), grants: payload.grants }, 201));
}

export async function revokeVaultAgentToken(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const tokenId = context.req.param('tokenId') ?? '';
  if (!isUUID(tokenId)) throw new ApiError(422, 'VALIDATION_ERROR', 'tokenId must be a valid UUID.');
  await requireVaultOperationApproval(context, auth, { action: 'token:revoke', projectId: null, environmentId: null, secretId: null, targetTokenId: tokenId, expectedVersion: null, requestHash: await hashVaultApprovalRequest({ operation: 'token-revoked', tokenId }) });
  const result = record(assertSupabase(await serviceClient.rpc('qnotes_revoke_vault_agent_token', { p_owner_id: auth.userId, p_token_id: tokenId, p_request_id: context.get('requestId') })));
  if (result.status === 'not_found') throw new ApiError(404, 'VAULT_AGENT_TOKEN_NOT_FOUND', 'The Vault agent token was not found.');
  if (result.status !== 'ok') throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to revoke Vault agent token.');
  return dataBody(context, null);
}

export async function listVaultAudit(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const { data, error } = await appDbClient.from('vault_audit_events').select('id, actor_kind, actor_token_id, target_token_id, action, project_id, environment_id, secret_id, purpose, success, result_code, request_id, operation_id, policy_revision, retention_expires_at, occurred_at').eq('owner_id', auth.userId).order('occurred_at', { ascending: false }).limit(200);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault audit events.');
  const rows = Array.isArray(data) ? data.map((row) => record(row)) : [];
  const actorTokenIds = [...new Set(rows
    .filter((row) => row.actor_kind === 'vault_agent' && typeof row.actor_token_id === 'string')
    .map((row) => row.actor_token_id as string))];
  const actorTokens = new Map<string, { name: string; prefix: string | null }>();
  if (actorTokenIds.length) {
    const tokenResult = await appDbClient.from('vault_agent_tokens').select('id, name, token_prefix').eq('owner_id', auth.userId).in('id', actorTokenIds);
    if (tokenResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault audit actor metadata.');
    for (const row of Array.isArray(tokenResult.data) ? tokenResult.data : []) {
      const item = record(row);
      const id = typeof item.id === 'string' ? item.id : null;
      const name = typeof item.name === 'string' ? item.name : null;
      const prefix = typeof item.token_prefix === 'string' && /^qvt_[A-Za-z0-9_-]{8}$/.test(item.token_prefix) ? item.token_prefix : null;
      if (id && name) actorTokens.set(id, { name, prefix });
    }
  }
  return dataBody(context, rows.map((item) => {
    const actorKind = String(item.actor_kind) as 'user_jwt' | 'vault_agent' | 'system';
    const actorTokenId = actorKind === 'vault_agent' && typeof item.actor_token_id === 'string' ? item.actor_token_id : null;
    const actorToken = actorTokenId ? actorTokens.get(actorTokenId) : undefined;
    return {
      id: String(item.id),
      actorKind,
      actorTokenId,
      actorTokenName: actorToken?.name ?? null,
      actorTokenPrefix: actorToken?.prefix ?? null,
      targetTokenId: item.target_token_id ? String(item.target_token_id) : null,
      action: String(item.action) as VaultAuditAction,
      projectId: item.project_id ? String(item.project_id) : null,
      environmentId: item.environment_id ? String(item.environment_id) : null,
      secretId: item.secret_id ? String(item.secret_id) : null,
      purpose: item.purpose ? String(item.purpose) : null,
      success: Boolean(item.success),
      resultCode: item.result_code ? String(item.result_code) : null,
      requestId: item.request_id ? String(item.request_id) : null,
      operationId: item.operation_id ? String(item.operation_id) : null,
      policyRevision: String(item.policy_revision),
      retentionExpiresAt: String(item.retention_expires_at),
      occurredAt: String(item.occurred_at),
    };
  }));
}

export async function replaceVaultAgentGrants(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const tokenId = context.req.param('tokenId') ?? '';
  if (!isUUID(tokenId)) throw new ApiError(422, 'VALIDATION_ERROR', 'tokenId must be a valid UUID.');
  const validation = validateReplaceVaultAgentGrantsInput(await context.req.json());
  await requireVaultOperationApproval(context, auth, { action: 'grant:replace', projectId: null, environmentId: null, secretId: null, targetTokenId: tokenId, expectedVersion: null, requestHash: await hashVaultApprovalRequest({ operation: 'grants-replaced', tokenId, grants: validation.grants }) });
  const result = assertSupabase(await serviceClient.rpc('qnotes_replace_vault_agent_grants', { p_owner_id: auth.userId, p_token_id: tokenId, p_grants: validation.grants, p_request_id: context.get('requestId') }));
  if (record(result).status === 'not_found') throw new ApiError(404, 'VAULT_AGENT_TOKEN_NOT_FOUND', 'The Vault agent token was not found.');
  if (record(result).status !== 'ok') throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to update Vault grants.');
  const grants = record(result).grants;
  if (!Array.isArray(grants)) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to update Vault grants.');
  return dataBody(context, grants.map((grant) => grantMetadata(record(grant))));
}
