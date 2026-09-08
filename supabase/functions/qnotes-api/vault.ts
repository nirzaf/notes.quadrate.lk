import type { Context } from 'hono';
import { isUUID, validateCreateVaultAgentTokenInput, validateCreateVaultEnvironmentInput, validateCreateVaultProjectInput, validateCreateVaultSecretInput, validateDeleteVaultSecretInput, validateRevealVaultSecretInput, validateRevealVaultSecretsInput, validateReplaceVaultAgentGrantsInput, validateRotateVaultSecretInput, type VaultAction, type VaultAgentGrant } from '@qnotes/shared';
import { assertSupabase, appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { vaultAuthFromContext, requireVaultUserJwt } from '../_shared/vault-auth.ts';
import { grantAllows, requireVaultAccess, vaultGrants } from '../_shared/vault-authorization.ts';
import { hashVaultMutation } from '../_shared/vault-token.ts';
import { generateVaultAgentToken, hashVaultAgentToken } from '../_shared/vault-token.ts';

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

function projectMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: row.description ? String(row.description) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at ? String(row.archived_at) : null };
}

function environmentMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), projectId: String(row.project_id), slug: String(row.slug), name: String(row.name), description: row.description ? String(row.description) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at ? String(row.archived_at) : null };
}

function secretMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), projectId: String(row.project_id), environmentId: String(row.environment_id), name: String(row.name), description: row.description ? String(row.description) : null, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), rotatedAt: row.rotated_at ? String(row.rotated_at) : null, deletedAt: row.deleted_at ? String(row.deleted_at) : null };
}

function grantMetadata(row: Record<string, unknown>): VaultAgentGrant {
  return {
    id: row.id ? String(row.id) : undefined,
    projectId: String(row.project_id ?? row.projectId),
    environmentId: row.environment_id === null || row.environment_id === undefined ? row.environmentId === null || row.environmentId === undefined ? null : String(row.environmentId) : String(row.environment_id),
    secretId: row.secret_id === null || row.secret_id === undefined ? row.secretId === null || row.secretId === undefined ? null : String(row.secretId) : String(row.secret_id),
    action: String(row.action) as VaultAction,
    createdAt: row.created_at ? String(row.created_at) : row.createdAt ? String(row.createdAt) : undefined,
  };
}

function tokenMetadata(row: Record<string, unknown>) {
  return { id: String(row.id), name: String(row.name), tokenPrefix: String(row.token_prefix ?? row.tokenPrefix), expiresAt: row.expires_at ? String(row.expires_at) : row.expiresAt ? String(row.expiresAt) : null, lastUsedAt: row.last_used_at ? String(row.last_used_at) : row.lastUsedAt ? String(row.lastUsedAt) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : row.revokedAt ? String(row.revokedAt) : null, createdAt: String(row.created_at ?? row.createdAt), grants: Array.isArray(row.grants) ? row.grants.map((grant) => grantMetadata(record(grant))) : [] };
}

async function findProject(ownerId: string, reference: string, activeOnly = true): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_projects').select('*').eq('owner_id', ownerId).limit(1);
  query = isUUID(reference) ? query.eq('id', reference) : query.eq('slug', reference.trim().toLowerCase());
  if (activeOnly) query = query.is('archived_at', null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_PROJECT_NOT_FOUND', 'The Vault project was not found.');
  return record(data);
}

async function findEnvironment(ownerId: string, projectId: string, reference: string, activeOnly = true): Promise<Record<string, unknown>> {
  let query = appDbClient.from('vault_environments').select('*').eq('owner_id', ownerId).eq('project_id', projectId).limit(1);
  query = isUUID(reference) ? query.eq('id', reference) : query.eq('slug', reference.trim().toLowerCase());
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

function mapVaultMutation(value: unknown, action: 'create' | 'rotate' | 'delete') {
  const result = record(value);
  const status = result.status;
  if (status === 'ok' || status === 'idempotent') {
    const secret = record(result.secret);
    if (!secret.id) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault mutation returned an invalid result.');
    return secretMetadata({ id: secret.id, project_id: secret.projectId, environment_id: secret.environmentId, name: secret.name, description: secret.description, version: secret.version, created_at: secret.createdAt, updated_at: secret.updatedAt, rotated_at: secret.rotatedAt, deleted_at: secret.deletedAt });
  }
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
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_reveal_secret', {
    p_owner_id: auth.userId,
    p_secret_id: String(secret.id),
    p_actor_token_id: actorTokenId(auth),
    p_purpose: purpose,
    p_request_id: context.get('requestId'),
    p_actor_kind: actorKind(auth),
  }));
  const payload = record(result);
  if (payload.status === 'not_found') throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
  if (payload.status === 'vault_missing') throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault value is unavailable.');
  if (payload.status !== 'ok' || !record(payload.secret)) throw new ApiError(500, 'INTERNAL_ERROR', 'The Vault reveal failed.');
  return record(payload.secret);
}

export async function listVaultProjects(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const { data, error } = await appDbClient.from('vault_projects').select('*').eq('owner_id', auth.userId).is('archived_at', null).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault projects.');
  const rows = Array.isArray(data) ? data.map((row) => record(row)) : [];
  if (auth.authKind === 'jwt') return dataBody(context, rows.map(projectMetadata));
  const grants = await vaultGrants(auth, 'metadata:read');
  return dataBody(context, rows.filter((row) => grants.some((grant) => grant.project_id === String(row.id))).map(projectMetadata));
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
  const { data, error } = await appDbClient.from('vault_environments').select('*').eq('owner_id', auth.userId).eq('project_id', projectId).is('archived_at', null).order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault environments.');
  const rows = Array.isArray(data) ? data.map((row) => record(row)) : [];
  if (auth.authKind === 'jwt') return dataBody(context, rows.map(environmentMetadata));
  const grants = await vaultGrants(auth, 'metadata:read');
  return dataBody(context, rows.filter((row) => grantAllows(grants, 'metadata:read', { ownerId: auth.userId, projectId, environmentId: String(row.id) })).map(environmentMetadata));
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
  const { data, error } = await appDbClient.from('vault_secrets').select('*').eq('owner_id', auth.userId).eq('project_id', projectId).eq('environment_id', environmentId).is('deleted_at', null).order('name', { ascending: true });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault secrets.');
  const rows = Array.isArray(data) ? data.map((row) => record(row)) : [];
  if (auth.authKind === 'jwt') return dataBody(context, rows.map(secretMetadata));
  const grants = await vaultGrants(auth, 'metadata:read');
  return dataBody(context, rows.filter((row) => grantAllows(grants, 'metadata:read', { ownerId: auth.userId, projectId, environmentId, secretId: String(row.id) })).map(secretMetadata));
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

async function createVaultSecretForEnvironment(context: Context, project: Record<string, unknown>, environment: Record<string, unknown>): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateCreateVaultSecretInput({ ...(await context.req.json()), projectId: project.id, environmentId: environment.id });
  await requireVaultAccess(auth, 'secret:write', { ownerId: auth.userId, projectId: String(project.id), environmentId: String(environment.id), secretId: null });
  const requestHash = await hashVaultMutation({ operation: 'created', projectId: project.id, environmentId: environment.id, name: input.name, description: input.description ?? null, value: input.value });
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_create_secret', { p_owner_id: auth.userId, p_project_id: project.id, p_environment_id: environment.id, p_name: input.name, p_description: input.description ?? null, p_value: input.value, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, mapVaultMutation(result, 'create'), record(result).status === 'idempotent' ? 200 : 201);
}

export async function createVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const environment = await findEnvironmentById(auth.userId, context.req.param('environmentId') ?? '');
  const project = await findProject(auth.userId, String(environment.project_id));
  return createVaultSecretForEnvironment(context, project, environment);
}

export async function createVaultSecretBySelector(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const project = await findProject(auth.userId, context.req.param('projectRef') ?? '');
  const environment = await findEnvironment(auth.userId, String(project.id), context.req.param('environmentRef') ?? '');
  return createVaultSecretForEnvironment(context, project, environment);
}

export async function getVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secret = await findSecret(auth.userId, context.req.param('secretId') ?? '');
  await requireVaultAccess(auth, 'metadata:read', { ownerId: auth.userId, projectId: String(secret.project_id), environmentId: String(secret.environment_id), secretId: String(secret.id) });
  return dataBody(context, secretMetadata(secret));
}

export async function rotateVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secretId = context.req.param('secretId') ?? '';
  if (!isUUID(secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  const secret = await findSecret(auth.userId, secretId);
  const input = validateRotateVaultSecretInput(await context.req.json());
  await requireVaultAccess(auth, 'secret:write', { ownerId: auth.userId, projectId: String(secret.project_id), environmentId: String(secret.environment_id), secretId });
  const requestHash = await hashVaultMutation({ operation: 'rotated', secretId, value: input.value, description: input.description ?? null });
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_rotate_secret', { p_owner_id: auth.userId, p_secret_id: secretId, p_value: input.value, p_description: input.description ?? null, p_expected_version: input.expectedVersion, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, mapVaultMutation(result, 'rotate'));
}

export async function deleteVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const secretId = context.req.param('secretId') ?? '';
  if (!isUUID(secretId)) throw new ApiError(422, 'VALIDATION_ERROR', 'secretId must be a valid UUID.');
  const secret = await findSecret(auth.userId, secretId);
  const input = validateDeleteVaultSecretInput(await context.req.json());
  await requireVaultAccess(auth, 'secret:delete', { ownerId: auth.userId, projectId: String(secret.project_id), environmentId: String(secret.environment_id), secretId });
  const requestHash = await hashVaultMutation({ operation: 'deleted', secretId, expectedVersion: input.expectedVersion });
  const result = assertSupabase(await serviceClient.rpc('qnotes_vault_delete_secret', { p_owner_id: auth.userId, p_secret_id: secretId, p_expected_version: input.expectedVersion, p_mutation_id: input.mutationId, p_request_hash: requestHash, p_actor_token_id: actorTokenId(auth), p_request_id: context.get('requestId'), p_actor_kind: actorKind(auth) }));
  return dataBody(context, mapVaultMutation(result, 'delete'));
}

export async function revealVaultSecret(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateRevealVaultSecretInput(await context.req.json());
  const project = await findProject(auth.userId, input.project);
  const environment = await findEnvironment(auth.userId, String(project.id), input.environment);
  const { data, error } = await appDbClient.from('vault_secrets').select('*').eq('owner_id', auth.userId).eq('project_id', project.id).eq('environment_id', environment.id).eq('name', input.name).is('deleted_at', null).maybeSingle();
  if (error || !data) throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
  const secret = record(data);
  await requireVaultAccess(auth, 'secret:reveal', { ownerId: auth.userId, projectId: String(project.id), environmentId: String(environment.id), secretId: String(secret.id) });
  return noStore(dataBody(context, await revealById(context, auth, secret, input.purpose)));
}

export async function revealVaultSecrets(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  const input = validateRevealVaultSecretsInput(await context.req.json());
  const resolved: Array<{ secret: Record<string, unknown>; selector: typeof input.secrets[number] }> = [];
  for (const selector of input.secrets) {
    const project = await findProject(auth.userId, selector.project);
    const environment = await findEnvironment(auth.userId, String(project.id), selector.environment);
    const { data, error } = await appDbClient.from('vault_secrets').select('*').eq('owner_id', auth.userId).eq('project_id', project.id).eq('environment_id', environment.id).eq('name', selector.name).is('deleted_at', null).maybeSingle();
    if (error || !data) throw new ApiError(404, 'VAULT_SECRET_NOT_FOUND', 'The Vault secret was not found.');
    const secret = record(data);
    await requireVaultAccess(auth, 'secret:reveal', { ownerId: auth.userId, projectId: String(project.id), environmentId: String(environment.id), secretId: String(secret.id) });
    resolved.push({ secret, selector });
  }
  const items: Record<string, unknown>[] = [];
  let totalBytes = 0;
  for (const { secret } of resolved) {
    const revealed = await revealById(context, auth, secret, input.purpose);
    totalBytes += new TextEncoder().encode(String(revealed.value ?? '')).byteLength;
    if (totalBytes > 262_144) throw new ApiError(413, 'VAULT_SECRET_TOO_LARGE', 'The combined Vault reveal is too large.');
    items.push(revealed);
  }
  return noStore(dataBody(context, { items }));
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
    const grantResult = await appDbClient.from('vault_agent_grants').select('id, token_id, project_id, environment_id, secret_id, action, created_at').eq('owner_id', auth.userId).in('token_id', tokenIds).order('created_at', { ascending: true });
    if (grantResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault agent grants.');
    for (const row of Array.isArray(grantResult.data) ? grantResult.data : []) {
      const item = record(row);
      const tokenId = String(item.token_id);
      const grants = grantsByToken.get(tokenId) ?? [];
      grants.push(grantMetadata(item));
      grantsByToken.set(tokenId, grants);
    }
  }
  return dataBody(context, tokenRows.map((row) => tokenMetadata({ ...row, grants: grantsByToken.get(String(row.id)) ?? [] })));
}

export async function createVaultAgentToken(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const input = validateCreateVaultAgentTokenInput(await context.req.json());
  const token = generateVaultAgentToken();
  const tokenHash = await hashVaultAgentToken(token);
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_vault_agent_token', { p_owner_id: auth.userId, p_name: input.name, p_token_prefix: token.slice(0, 12), p_token_hash: tokenHash, p_expires_at: input.expiresAt, p_grants: input.grants }));
  const payload = record(result);
  if (!payload.id || !Array.isArray(payload.grants)) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create Vault agent token.');
  return noStore(dataBody(context, { token, metadata: tokenMetadata(payload), grants: payload.grants }, 201));
}

export async function revokeVaultAgentToken(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const tokenId = context.req.param('tokenId') ?? '';
  const { data, error } = await appDbClient.from('vault_agent_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', tokenId).eq('owner_id', auth.userId).is('revoked_at', null).select('id').maybeSingle();
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to revoke Vault agent token.');
  if (!data) throw new ApiError(404, 'VAULT_AGENT_TOKEN_NOT_FOUND', 'The Vault agent token was not found.');
  return dataBody(context, null);
}

export async function listVaultAudit(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const { data, error } = await appDbClient.from('vault_audit_events').select('id, actor_kind, action, project_id, environment_id, secret_id, purpose, success, result_code, request_id, occurred_at').eq('owner_id', auth.userId).order('occurred_at', { ascending: false }).limit(200);
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list Vault audit events.');
  return dataBody(context, (Array.isArray(data) ? data : []).map((row) => { const item = record(row); return { id: String(item.id), actorKind: String(item.actor_kind), action: String(item.action) as VaultAction, projectId: item.project_id ? String(item.project_id) : null, environmentId: item.environment_id ? String(item.environment_id) : null, secretId: item.secret_id ? String(item.secret_id) : null, purpose: item.purpose ? String(item.purpose) : null, success: Boolean(item.success), resultCode: item.result_code ? String(item.result_code) : null, requestId: item.request_id ? String(item.request_id) : null, occurredAt: String(item.occurred_at) }; }));
}

export async function replaceVaultAgentGrants(context: Context): Promise<Response> {
  const auth = vaultAuthFromContext(context);
  requireVaultUserJwt(auth);
  const tokenId = context.req.param('tokenId') ?? '';
  const validation = validateReplaceVaultAgentGrantsInput(await context.req.json());
  const result = assertSupabase(await serviceClient.rpc('qnotes_replace_vault_agent_grants', { p_owner_id: auth.userId, p_token_id: tokenId, p_grants: validation.grants }));
  if (record(result).status === 'not_found') throw new ApiError(404, 'VAULT_AGENT_TOKEN_NOT_FOUND', 'The Vault agent token was not found.');
  if (record(result).status !== 'ok') throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to update Vault grants.');
  const grants = record(result).grants;
  if (!Array.isArray(grants)) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to update Vault grants.');
  return dataBody(context, grants.map((grant) => grantMetadata(record(grant))));
}
