import type {
  CreateVaultAgentTokenInput,
  CreateVaultAgentTokenResult,
  CreateVaultEnvironmentInput,
  CreateVaultProjectInput,
  CreateVaultSecretInput,
  DeleteVaultSecretInput,
  RevealVaultSecretInput,
  RevealVaultSecretResult,
  RevealVaultSecretsInput,
  RevealVaultSecretsResult,
  RotateVaultSecretInput,
  VaultAgentGrant,
  VaultAgentTokenMetadata,
  VaultAuditEvent,
  VaultEnvironment,
  VaultOperationApprovalInput,
  VaultOperationApprovalResult,
  VaultProject,
  VaultSecretMetadata,
} from '@qnotes/shared';
import { QNotesHttpError } from './http-error.ts';
import type { QNotesClientOptions, RequestOptions } from './client.ts';
import { createRequestSignal, redactSensitive, requestSecrets, throwIfAborted, validateApiEndpoint } from './endpoint-policy.ts';

export class QVaultProtocolError extends Error {
  constructor(resource: string) {
    super(`QVault API returned a malformed ${resource} payload.`);
    this.name = 'QVaultProtocolError';
  }
}

type Success<T> = { data: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === 'string'; }
function isNullableString(value: unknown): value is string | null { return value === null || isString(value); }
function isInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function isNullableUuid(value: unknown): value is string | null {
  return value === null || (isString(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isProject(value: unknown): value is VaultProject {
  return isRecord(value) && hasExactKeys(value, ['id', 'slug', 'name', 'description', 'createdAt', 'updatedAt', 'archivedAt'])
    && isString(value.id) && isString(value.slug) && isString(value.name) && isNullableString(value.description)
    && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.archivedAt);
}

function isEnvironment(value: unknown): value is VaultEnvironment {
  return isRecord(value) && hasExactKeys(value, ['id', 'projectId', 'slug', 'name', 'description', 'createdAt', 'updatedAt', 'archivedAt'])
    && isString(value.id) && isString(value.projectId) && isString(value.slug) && isString(value.name)
    && isNullableString(value.description) && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.archivedAt);
}

function isSecretMetadata(value: unknown): value is VaultSecretMetadata {
  return isRecord(value) && hasExactKeys(value, ['id', 'projectId', 'environmentId', 'name', 'description', 'version', 'createdAt', 'updatedAt', 'rotatedAt', 'deletedAt'])
    && isString(value.id) && isString(value.projectId) && isString(value.environmentId) && isString(value.name)
    && isNullableString(value.description) && isInteger(value.version) && value.version > 0 && isString(value.createdAt)
    && isString(value.updatedAt) && isNullableString(value.rotatedAt) && isNullableString(value.deletedAt);
}

function isAgentTokenMetadata(value: unknown): value is VaultAgentTokenMetadata {
  return isRecord(value) && hasExactKeys(value, ['id', 'name', 'tokenPrefix', 'expiresAt', 'lastUsedAt', 'revokedAt', 'createdAt', 'grants'])
    && isString(value.id) && isString(value.name) && isString(value.tokenPrefix) && /^qvt_[A-Za-z0-9_-]{8}$/.test(value.tokenPrefix)
    && isNullableString(value.expiresAt) && isNullableString(value.lastUsedAt) && isNullableString(value.revokedAt) && isString(value.createdAt)
    && Array.isArray(value.grants) && value.grants.every(isGrant);
}

function isGrant(value: unknown): value is VaultAgentGrant {
  return isRecord(value) && hasOnlyAllowedKeys(value, ['id', 'projectId', 'projectName', 'environmentId', 'environmentName', 'secretId', 'secretName', 'action', 'createdAt'])
    && isString(value.projectId) && isNullableString(value.environmentId) && isNullableString(value.secretId)
    && ['metadata:read', 'secret:reveal', 'secret:write', 'secret:delete'].includes(String(value.action))
    && (value.id === undefined || isString(value.id)) && (value.createdAt === undefined || isString(value.createdAt))
    && (value.projectName === undefined || isString(value.projectName))
    && (value.environmentName === undefined || isString(value.environmentName))
    && (value.secretName === undefined || isString(value.secretName));
}

function isAuditEvent(value: unknown): value is VaultAuditEvent {
  return isRecord(value) && hasExactKeys(value, ['id', 'actorKind', 'actorTokenId', 'actorTokenName', 'actorTokenPrefix', 'targetTokenId', 'action', 'projectId', 'environmentId', 'secretId', 'purpose', 'success', 'resultCode', 'requestId', 'operationId', 'policyRevision', 'retentionExpiresAt', 'occurredAt'])
    && isString(value.id) && ['user_jwt', 'vault_agent', 'system'].includes(String(value.actorKind))
    && isNullableUuid(value.actorTokenId) && isNullableString(value.actorTokenName) && isNullableUuid(value.targetTokenId)
    && (value.actorTokenPrefix === null || (isString(value.actorTokenPrefix) && /^qvt_[A-Za-z0-9_-]{8}$/.test(value.actorTokenPrefix)))
    && ['metadata:read', 'secret:reveal', 'secret:write', 'secret:delete', 'secret:use', 'token:issue', 'token:revoke', 'grant:replace', 'auth:step_up', 'approval:issue', 'approval:consume', 'access:denied', 'admin:recovery'].includes(String(value.action))
    && isNullableString(value.projectId) && isNullableString(value.environmentId) && isNullableString(value.secretId)
    && isNullableString(value.purpose) && typeof value.success === 'boolean' && isNullableString(value.resultCode)
    && isNullableString(value.requestId) && isNullableString(value.operationId) && isString(value.policyRevision)
    && isString(value.retentionExpiresAt) && isString(value.occurredAt);
}

function listPayload<T>(value: unknown, validator: (item: unknown) => item is T, resource: string): T[] {
  const items = Array.isArray(value) ? value : isRecord(value) && hasExactKeys(value, ['items']) && Array.isArray(value.items) ? value.items : null;
  if (!items || !items.every(validator)) throw new QVaultProtocolError(resource);
  return items;
}

function metadataPayload<T>(value: unknown, validator: (item: unknown) => item is T, resource: string): T {
  if (!validator(value)) throw new QVaultProtocolError(resource);
  return value;
}

function revealPayload(value: unknown): value is RevealVaultSecretResult {
  return isRecord(value) && hasExactKeys(value, ['secretId', 'project', 'environment', 'name', 'value', 'version', 'updatedAt'])
    && isString(value.secretId) && isString(value.project) && isString(value.environment) && isString(value.name)
    && isString(value.value) && isInteger(value.version) && value.version > 0 && isString(value.updatedAt);
}

function revealBatchPayload(value: unknown): value is RevealVaultSecretsResult {
  return isRecord(value) && hasExactKeys(value, ['items']) && Array.isArray(value.items) && value.items.every(revealPayload);
}

function tokenResult(value: unknown): value is CreateVaultAgentTokenResult {
  return isRecord(value) && hasExactKeys(value, ['token', 'metadata', 'grants'])
    && isString(value.token) && /^qvt_[A-Za-z0-9_-]{43}$/.test(value.token) && isAgentTokenMetadata(value.metadata)
    && Array.isArray(value.grants) && value.grants.every(isGrant);
}

function approvalResult(value: unknown): value is VaultOperationApprovalResult {
  return isRecord(value) && hasExactKeys(value, ['approvalToken', 'expiresAt'])
    && isString(value.approvalToken) && /^qva_[A-Za-z0-9_-]{43}$/.test(value.approvalToken) && isString(value.expiresAt);
}

export class QVaultClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: QNotesClientOptions['getAccessToken'];
  private readonly fetchImplementation: typeof fetch;

  constructor(options: QNotesClientOptions) {
    this.baseUrl = validateApiEndpoint(options.baseUrl, options.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: options.allowInsecureLoopback }).replace(/\/+$/, '');
    this.getAccessToken = options.getAccessToken;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const requestSignal = createRequestSignal(options.signal ?? init.signal, options.timeoutMs);
    try {
      throwIfAborted(requestSignal.signal);
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (options.vaultApproval) {
        headers.set('X-Vault-Approval', options.vaultApproval.approvalToken);
        headers.set('X-Vault-Request-Hash', options.vaultApproval.requestHash);
      }
      const token = await this.getAccessToken(requestSignal.signal);
      throwIfAborted(requestSignal.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const secrets = requestSecrets(init.body, token);
      const response = await this.fetchImplementation(`${this.baseUrl}/vault${path}`, {
        ...init,
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal.signal,
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const body: unknown = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json().catch(() => null) : null;
        const envelope = isRecord(body) && isRecord(body.error) ? body.error : {};
        throw new QNotesHttpError(response.status, (isString(envelope.code) ? envelope.code : 'INTERNAL_ERROR') as QNotesHttpError['code'], isString(envelope.message) ? redactSensitive(envelope.message, secrets) as string : `Vault request failed with HTTP ${response.status}.`, isString(envelope.requestId) ? redactSensitive(envelope.requestId, secrets) as string : redactSensitive(response.headers.get('x-request-id') ?? '', secrets) as string, redactSensitive(envelope.details, secrets));
      }
      const body: unknown = await response.json();
      throwIfAborted(requestSignal.signal);
      if (!isRecord(body) || !('data' in body)) throw new QVaultProtocolError('success');
      return (body as Success<T>).data;
    } catch (error) {
      throwIfAborted(requestSignal.signal);
      if (error instanceof QNotesHttpError || error instanceof QVaultProtocolError) throw error;
      throw new Error('QVault request failed.');
    } finally {
      requestSignal.cleanup();
    }
  }

  private async validated<T>(path: string, validator: (value: unknown) => value is T, resource: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    return metadataPayload(await this.request<unknown>(path, init, options), validator, resource);
  }

  listProjects(options: RequestOptions = {}): Promise<VaultProject[]> {
    return this.request<unknown>('/projects', {}, options).then((value) => listPayload(value, isProject, 'projects'));
  }

  createProject(input: CreateVaultProjectInput, options: RequestOptions = {}): Promise<VaultProject> {
    return this.validated('/projects', isProject, 'project', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  listEnvironments(projectId: string, options: RequestOptions = {}): Promise<VaultEnvironment[]> {
    return this.request<unknown>(`/projects/${encodeURIComponent(projectId)}/environments`, {}, options).then((value) => listPayload(value, isEnvironment, 'environments'));
  }

  createEnvironment(projectId: string, input: Omit<CreateVaultEnvironmentInput, 'projectId'>, options: RequestOptions = {}): Promise<VaultEnvironment> {
    return this.validated(`/projects/${encodeURIComponent(projectId)}/environments`, isEnvironment, 'environment', { method: 'POST', body: JSON.stringify({ ...input, projectId }) }, options);
  }

  listSecrets(environmentId: string, options: RequestOptions = {}): Promise<VaultSecretMetadata[]> {
    return this.request<unknown>(`/environments/${encodeURIComponent(environmentId)}/secrets`, {}, options).then((value) => listPayload(value, isSecretMetadata, 'secrets'));
  }

  createSecret(input: CreateVaultSecretInput, options: RequestOptions = {}): Promise<VaultSecretMetadata> {
    return this.validated(`/environments/${encodeURIComponent(input.environmentId)}/secrets`, isSecretMetadata, 'secret metadata', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  getSecret(secretId: string, options: RequestOptions = {}): Promise<VaultSecretMetadata> {
    return this.validated(`/secrets/${encodeURIComponent(secretId)}`, isSecretMetadata, 'secret metadata', {}, options);
  }

  rotateSecret(secretId: string, input: RotateVaultSecretInput, options: RequestOptions = {}): Promise<VaultSecretMetadata> {
    return this.validated(`/secrets/${encodeURIComponent(secretId)}`, isSecretMetadata, 'secret metadata', { method: 'PATCH', body: JSON.stringify(input) }, options);
  }

  deleteSecret(secretId: string, input: DeleteVaultSecretInput, options: RequestOptions = {}): Promise<VaultSecretMetadata> {
    return this.validated(`/secrets/${encodeURIComponent(secretId)}`, isSecretMetadata, 'secret tombstone', { method: 'DELETE', body: JSON.stringify(input) }, options);
  }

  revealSecret(input: RevealVaultSecretInput, options: RequestOptions = {}): Promise<RevealVaultSecretResult> {
    return this.validated('/secrets/reveal', revealPayload, 'reveal', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  revealSecrets(input: RevealVaultSecretsInput, options: RequestOptions = {}): Promise<RevealVaultSecretsResult> {
    return this.validated('/secrets/reveal-batch', revealBatchPayload, 'reveal batch', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  issueApproval(input: VaultOperationApprovalInput, options: RequestOptions = {}): Promise<VaultOperationApprovalResult> {
    return this.validated('/approvals', approvalResult, 'Vault operation approval', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  listAgentTokens(options: RequestOptions = {}): Promise<VaultAgentTokenMetadata[]> {
    return this.request<unknown>('/agent-tokens', {}, options).then((value) => listPayload(value, isAgentTokenMetadata, 'agent tokens'));
  }

  createAgentToken(input: CreateVaultAgentTokenInput, options: RequestOptions = {}): Promise<CreateVaultAgentTokenResult> {
    return this.validated('/agent-tokens', tokenResult, 'agent token', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  replaceAgentGrants(tokenId: string, grants: VaultAgentGrant[], options: RequestOptions = {}): Promise<VaultAgentGrant[]> {
    return this.request<unknown>(`/agent-tokens/${encodeURIComponent(tokenId)}/grants`, { method: 'PATCH', body: JSON.stringify({ grants }) }, options)
      .then((value) => listPayload(value, isGrant, 'agent grants'));
  }

  async revokeAgentToken(tokenId: string, options: RequestOptions = {}): Promise<void> {
    await this.request('/agent-tokens/' + encodeURIComponent(tokenId), { method: 'DELETE' }, options);
  }

  listAudit(options: RequestOptions = {}): Promise<VaultAuditEvent[]> {
    return this.request<unknown>('/audit', {}, options).then((value) => listPayload(value, isAuditEvent, 'audit events'));
  }
}
