import { QNotesValidationError } from './errors.ts';

export type VaultAction = 'metadata:read' | 'secret:reveal' | 'secret:write' | 'secret:delete';
export type VaultAuditAction = VaultAction | 'secret:use' | 'token:issue' | 'token:revoke' | 'grant:replace' | 'auth:step_up' | 'approval:issue' | 'approval:consume' | 'access:denied' | 'admin:recovery';
export type VaultActorKind = 'user_jwt' | 'vault_agent' | 'system';
export type VaultSensitiveAction = 'secret:reveal' | 'secret:write' | 'secret:delete' | 'token:issue' | 'token:revoke' | 'grant:replace';

export const MAX_VAULT_PROJECT_NAME_LENGTH = 80;
export const MAX_VAULT_ENVIRONMENT_NAME_LENGTH = 80;
export const MAX_VAULT_SECRET_NAME_LENGTH = 128;
export const MAX_VAULT_DESCRIPTION_LENGTH = 500;
export const MAX_VAULT_PURPOSE_LENGTH = 200;
export const MAX_VAULT_SECRET_BYTES = 65_536;
export const MAX_VAULT_BATCH_REVEAL = 20;
export const MAX_VAULT_BATCH_BYTES = 262_144;
export const MAX_VAULT_AGENT_GRANTS = 100;
export const MAX_VAULT_AGENT_TOKEN_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export const VAULT_OPERATION_APPROVAL_SECONDS = 60;

const VAULT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const VAULT_SECRET_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const VAULT_AGENT_TOKEN_PATTERN = /^qvt_[A-Za-z0-9_-]{43}$/;
const VAULT_OPERATION_APPROVAL_PATTERN = /^qva_[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const VAULT_ACTIONS: VaultAction[] = ['metadata:read', 'secret:reveal', 'secret:write', 'secret:delete'];

export type VaultProject = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type VaultEnvironment = {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type VaultSecretMetadata = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  deletedAt: string | null;
};

export type VaultAgentTokenMetadata = {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  grants: VaultAgentGrant[];
};

export type VaultAgentGrant = {
  id?: string;
  projectId: string;
  projectName?: string;
  environmentId: string | null;
  environmentName?: string;
  secretId: string | null;
  secretName?: string;
  action: VaultAction;
  createdAt?: string;
};

export type VaultAuditEvent = {
  id: string;
  actorKind: VaultActorKind;
  actorTokenId: string | null;
  actorTokenName: string | null;
  actorTokenPrefix: string | null;
  targetTokenId: string | null;
  action: VaultAuditAction;
  projectId: string | null;
  environmentId: string | null;
  secretId: string | null;
  purpose: string | null;
  success: boolean;
  resultCode: string | null;
  requestId: string | null;
  operationId: string | null;
  policyRevision: string;
  retentionExpiresAt: string;
  occurredAt: string;
};

export type CreateVaultProjectInput = { slug?: string; name: string; description?: string | null };
export type CreateVaultEnvironmentInput = { projectId: string; slug?: string; name: string; description?: string | null };
export type CreateVaultSecretInput = { projectId: string; environmentId: string; name: string; value: string; description?: string | null; mutationId: string };
export type RotateVaultSecretInput = { value: string; description?: string | null; expectedVersion: number; mutationId: string };
export type DeleteVaultSecretInput = { expectedVersion: number; mutationId: string; confirm: true };
export type VaultSecretSelector = { project: string; environment: string; name: string };
export type RevealVaultSecretInput = VaultSecretSelector & { purpose: string };
export type RevealVaultSecretsInput = { secrets: VaultSecretSelector[]; purpose: string };
export type RevealVaultSecretResult = { secretId: string; project: string; environment: string; name: string; value: string; version: number; updatedAt: string };
export type RevealVaultSecretsResult = { items: RevealVaultSecretResult[] };
export type CreateVaultAgentTokenInput = { name: string; expiresAt: string; grants: VaultAgentGrant[] };
export type CreateVaultAgentTokenResult = { token: string; metadata: VaultAgentTokenMetadata; grants: VaultAgentGrant[] };
export type ReplaceVaultAgentGrantsInput = { grants: VaultAgentGrant[] };
export type VaultOperationApprovalInput = {
  action: VaultSensitiveAction;
  projectId: string | null;
  environmentId: string | null;
  secretId: string | null;
  expectedVersion: number | null;
  requestHash: string;
};
export type VaultOperationApprovalResult = { approvalToken: string; expiresAt: string };

export function isVaultAgentToken(value: unknown): value is string {
  return typeof value === 'string' && VAULT_AGENT_TOKEN_PATTERN.test(value);
}

export function isVaultOperationApprovalToken(value: unknown): value is string {
  return typeof value === 'string' && VAULT_OPERATION_APPROVAL_PATTERN.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new QNotesValidationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new QNotesValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) throw new QNotesValidationError(`${field} is required.`);
  if (normalized.length > max) throw new QNotesValidationError(`${field} must contain at most ${max} characters.`);
  return normalized || null;
}

export function normalizeVaultSlug(value: unknown, fallbackName?: string): string {
  const candidate = value === undefined ? fallbackName?.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) : value;
  if (typeof candidate !== 'string' || !VAULT_SLUG_PATTERN.test(candidate)) throw new QNotesValidationError('Vault slugs must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores.');
  return candidate;
}

export function normalizeVaultProjectName(value: unknown): string {
  const name = boundedText(value, 'project name', MAX_VAULT_PROJECT_NAME_LENGTH, true);
  return name as string;
}

export function normalizeVaultEnvironmentName(value: unknown): string {
  const name = boundedText(value, 'environment name', MAX_VAULT_ENVIRONMENT_NAME_LENGTH, true);
  return name as string;
}

export function normalizeVaultSecretName(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('secret name must be a string.');
  const name = value.trim();
  if (!VAULT_SECRET_NAME_PATTERN.test(name)) throw new QNotesValidationError('secret name must start with a letter, number, or underscore and contain only letters, numbers, underscores, dots, and hyphens.');
  return name;
}

export function normalizeVaultDescription(value: unknown, field = 'description'): string | null {
  return boundedText(value, field, MAX_VAULT_DESCRIPTION_LENGTH);
}

export function normalizeVaultPurpose(value: unknown): string {
  return boundedText(value, 'purpose', MAX_VAULT_PURPOSE_LENGTH, true) as string;
}

export function assertVaultSecretSize(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('value must be a string.');
  if (new TextEncoder().encode(value).byteLength > MAX_VAULT_SECRET_BYTES) throw new QNotesValidationError('Vault secret value is too large.');
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new QNotesValidationError(`${field} must be a valid UUID.`);
  return value;
}

function mutationId(value: unknown): string {
  return uuid(value, 'mutationId');
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new QNotesValidationError('expectedVersion must be a positive integer.');
  return value;
}

function validateSelector(value: unknown): VaultSecretSelector {
  if (!record(value)) throw new QNotesValidationError('Each secret selector must be an object.');
  return { project: normalizeVaultSlug(value.project), environment: normalizeVaultSlug(value.environment), name: normalizeVaultSecretName(value.name) };
}

export function validateCreateVaultProjectInput(value: unknown): CreateVaultProjectInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  const name = normalizeVaultProjectName(value.name);
  const slug = normalizeVaultSlug(value.slug, name);
  return { slug, name, description: normalizeVaultDescription(value.description) };
}

export function validateCreateVaultEnvironmentInput(value: unknown): CreateVaultEnvironmentInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  const name = normalizeVaultEnvironmentName(value.name);
  return { projectId: uuid(value.projectId, 'projectId'), slug: normalizeVaultSlug(value.slug, name), name, description: normalizeVaultDescription(value.description) };
}

export function validateCreateVaultSecretInput(value: unknown): CreateVaultSecretInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  const description = normalizeVaultDescription(value.description);
  return { projectId: uuid(value.projectId, 'projectId'), environmentId: uuid(value.environmentId, 'environmentId'), name: normalizeVaultSecretName(value.name), value: assertVaultSecretSize(value.value), ...(description === null ? {} : { description }), mutationId: mutationId(value.mutationId) };
}

export function validateRotateVaultSecretInput(value: unknown): RotateVaultSecretInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  const description = normalizeVaultDescription(value.description);
  return { value: assertVaultSecretSize(value.value), ...(description === null ? {} : { description }), expectedVersion: expectedVersion(value.expectedVersion), mutationId: mutationId(value.mutationId) };
}

export function validateDeleteVaultSecretInput(value: unknown): DeleteVaultSecretInput {
  if (!record(value) || value.confirm !== true) throw new QNotesValidationError('confirm must be true to delete a Vault secret.');
  return { expectedVersion: expectedVersion(value.expectedVersion), mutationId: mutationId(value.mutationId), confirm: true };
}

export function validateRevealVaultSecretInput(value: unknown): RevealVaultSecretInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  return { ...validateSelector(value), purpose: normalizeVaultPurpose(value.purpose) };
}

export function validateRevealVaultSecretsInput(value: unknown): RevealVaultSecretsInput {
  if (!record(value) || !Array.isArray(value.secrets)) throw new QNotesValidationError('secrets must be an explicit list.');
  if (value.secrets.length < 1) throw new QNotesValidationError('secrets must contain at least one selector.');
  if (value.secrets.length > MAX_VAULT_BATCH_REVEAL) throw new QNotesValidationError(`secrets may contain at most ${MAX_VAULT_BATCH_REVEAL} selectors.`);
  return { secrets: value.secrets.map(validateSelector), purpose: normalizeVaultPurpose(value.purpose) };
}

function validateGrant(value: unknown): VaultAgentGrant {
  if (!record(value)) throw new QNotesValidationError('Each Vault grant must be an object.');
  const environmentId = value.environmentId === null || value.environmentId === undefined ? null : uuid(value.environmentId, 'environmentId');
  const secretId = value.secretId === null || value.secretId === undefined ? null : uuid(value.secretId, 'secretId');
  if (secretId && !environmentId) throw new QNotesValidationError('secretId requires environmentId.');
  if (typeof value.action !== 'string' || !VAULT_ACTIONS.includes(value.action as VaultAction)) throw new QNotesValidationError('Vault grant action is invalid.');
  return { projectId: uuid(value.projectId, 'projectId'), environmentId, secretId, action: value.action as VaultAction };
}

export function validateCreateVaultAgentTokenInput(value: unknown): CreateVaultAgentTokenInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  const name = boundedText(value.name, 'token name', 80, true) as string;
  const expiresAt = value.expiresAt;
  const expiry = typeof expiresAt === 'string' && ISO_DATE_TIME_PATTERN.test(expiresAt) ? Date.parse(expiresAt) : Number.NaN;
  if (typeof expiresAt !== 'string' || Number.isNaN(expiry) || expiry <= Date.now() || expiry > Date.now() + MAX_VAULT_AGENT_TOKEN_LIFETIME_SECONDS * 1000) throw new QNotesValidationError(`expiresAt must be a future ISO date within ${MAX_VAULT_AGENT_TOKEN_LIFETIME_SECONDS / 86400} days.`);
  if (!Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > MAX_VAULT_AGENT_GRANTS) throw new QNotesValidationError(`grants must contain 1 to ${MAX_VAULT_AGENT_GRANTS} entries.`);
  return { name, expiresAt, grants: value.grants.map(validateGrant) };
}

const VAULT_SENSITIVE_ACTIONS: VaultSensitiveAction[] = ['secret:reveal', 'secret:write', 'secret:delete', 'token:issue', 'token:revoke', 'grant:replace'];

export function validateVaultOperationApprovalInput(value: unknown): VaultOperationApprovalInput {
  if (!record(value)) throw new QNotesValidationError('Request body must be an object.');
  if (typeof value.action !== 'string' || !VAULT_SENSITIVE_ACTIONS.includes(value.action as VaultSensitiveAction)) throw new QNotesValidationError('Vault approval action is invalid.');
  const projectId = value.projectId === null || value.projectId === undefined ? null : uuid(value.projectId, 'projectId');
  const environmentId = value.environmentId === null || value.environmentId === undefined ? null : uuid(value.environmentId, 'environmentId');
  const secretId = value.secretId === null || value.secretId === undefined ? null : uuid(value.secretId, 'secretId');
  const expectedVersion = value.expectedVersion === null || value.expectedVersion === undefined ? null : expectedVersionValue(value.expectedVersion);
  if (typeof value.requestHash !== 'string' || !SHA256_PATTERN.test(value.requestHash)) throw new QNotesValidationError('requestHash must be a lowercase SHA-256 digest.');
  return { action: value.action as VaultSensitiveAction, projectId, environmentId, secretId, expectedVersion, requestHash: value.requestHash };
}

function expectedVersionValue(value: unknown): number {
  return expectedVersion(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export async function hashVaultApprovalRequest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validateReplaceVaultAgentGrantsInput(value: unknown): ReplaceVaultAgentGrantsInput {
  if (!record(value) || !Array.isArray(value.grants) || value.grants.length > MAX_VAULT_AGENT_GRANTS) throw new QNotesValidationError(`grants must contain 0 to ${MAX_VAULT_AGENT_GRANTS} entries.`);
  return { grants: value.grants.map(validateGrant) };
}

export function validateVaultAction(value: unknown): VaultAction {
  if (typeof value !== 'string' || !VAULT_ACTIONS.includes(value as VaultAction)) throw new QNotesValidationError('Vault grant action is invalid.');
  return value as VaultAction;
}
