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
  VaultProject,
  VaultSecretMetadata,
} from '@qnotes/shared';
import { QNotesHttpError } from './http-error.ts';
import type { QNotesClientOptions, RequestOptions } from './client.ts';

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

function isProject(value: unknown): value is VaultProject {
  return isRecord(value) && isString(value.id) && isString(value.slug) && isString(value.name) && isNullableString(value.description)
    && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.archivedAt);
}

function isEnvironment(value: unknown): value is VaultEnvironment {
  return isRecord(value) && isString(value.id) && isString(value.projectId) && isString(value.slug) && isString(value.name)
    && isNullableString(value.description) && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.archivedAt);
}

function isSecretMetadata(value: unknown): value is VaultSecretMetadata {
  return isRecord(value) && isString(value.id) && isString(value.projectId) && isString(value.environmentId) && isString(value.name)
    && isNullableString(value.description) && isInteger(value.version) && value.version > 0 && isString(value.createdAt)
    && isString(value.updatedAt) && isNullableString(value.rotatedAt) && isNullableString(value.deletedAt) && !Object.hasOwn(value, 'value');
}

function isAgentTokenMetadata(value: unknown): value is VaultAgentTokenMetadata {
  return isRecord(value) && isString(value.id) && isString(value.name) && /^qvt_[A-Za-z0-9_-]{8}$/.test(String(value.tokenPrefix))
    && isNullableString(value.expiresAt) && isNullableString(value.lastUsedAt) && isNullableString(value.revokedAt) && isString(value.createdAt);
}

function isGrant(value: unknown): value is VaultAgentGrant {
  return isRecord(value) && isString(value.projectId) && isNullableString(value.environmentId) && isNullableString(value.secretId)
    && ['metadata:read', 'secret:reveal', 'secret:write', 'secret:delete'].includes(String(value.action));
}

function isAuditEvent(value: unknown): value is VaultAuditEvent {
  return isRecord(value) && isString(value.id) && ['user_jwt', 'vault_agent'].includes(String(value.actorKind)) && isString(value.action)
    && isNullableString(value.projectId) && isNullableString(value.environmentId) && isNullableString(value.secretId)
    && isNullableString(value.purpose) && typeof value.success === 'boolean' && isNullableString(value.resultCode)
    && isNullableString(value.requestId) && isString(value.occurredAt) && !Object.hasOwn(value, 'value');
}

function listPayload<T>(value: unknown, validator: (item: unknown) => item is T, resource: string): T[] {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : null;
  if (!items || !items.every(validator)) throw new QVaultProtocolError(resource);
  return items;
}

function metadataPayload<T>(value: unknown, validator: (item: unknown) => item is T, resource: string): T {
  if (!validator(value)) throw new QVaultProtocolError(resource);
  return value;
}

function revealPayload(value: unknown): value is RevealVaultSecretResult {
  return isRecord(value) && isString(value.secretId) && isString(value.project) && isString(value.environment) && isString(value.name)
    && isString(value.value) && isInteger(value.version) && value.version > 0 && isString(value.updatedAt)
    && Object.keys(value).every((key) => ['secretId', 'project', 'environment', 'name', 'value', 'version', 'updatedAt'].includes(key));
}

function revealBatchPayload(value: unknown): value is RevealVaultSecretsResult {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(revealPayload);
}

function tokenResult(value: unknown): value is CreateVaultAgentTokenResult {
  return isRecord(value) && isString(value.token) && /^qvt_[A-Za-z0-9_-]{43}$/.test(value.token) && isAgentTokenMetadata(value.metadata)
    && Array.isArray(value.grants) && value.grants.every(isGrant);
}

export class QVaultClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: QNotesClientOptions['getAccessToken'];
  private readonly fetchImplementation: typeof fetch;

  constructor(options: QNotesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = options.getAccessToken;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const token = await this.getAccessToken(options.signal ?? (init.signal ?? undefined));
    if (options.signal?.aborted) throw options.signal.reason;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetchImplementation(`${this.baseUrl}/vault${path}`, { ...init, headers, ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) {
      const body: unknown = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json().catch(() => null) : null;
      const envelope = isRecord(body) && isRecord(body.error) ? body.error : {};
      throw new QNotesHttpError(response.status, (isString(envelope.code) ? envelope.code : 'INTERNAL_ERROR') as QNotesHttpError['code'], isString(envelope.message) ? envelope.message : `Vault request failed with HTTP ${response.status}.`, isString(envelope.requestId) ? envelope.requestId : response.headers.get('x-request-id') ?? '', envelope.details);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !('data' in body)) throw new QVaultProtocolError('success');
    return (body as Success<T>).data;
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

  listAgentTokens(options: RequestOptions = {}): Promise<VaultAgentTokenMetadata[]> {
    return this.request<unknown>('/agent-tokens', {}, options).then((value) => listPayload(value, isAgentTokenMetadata, 'agent tokens'));
  }

  createAgentToken(input: CreateVaultAgentTokenInput, options: RequestOptions = {}): Promise<CreateVaultAgentTokenResult> {
    return this.validated('/agent-tokens', tokenResult, 'agent token', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  async revokeAgentToken(tokenId: string, options: RequestOptions = {}): Promise<void> {
    await this.request('/agent-tokens/' + encodeURIComponent(tokenId), { method: 'DELETE' }, options);
  }

  listAudit(options: RequestOptions = {}): Promise<VaultAuditEvent[]> {
    return this.request<unknown>('/audit', {}, options).then((value) => listPayload(value, isAuditEvent, 'audit events'));
  }
}
