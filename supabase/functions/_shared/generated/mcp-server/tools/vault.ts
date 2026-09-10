import type {
  CreateVaultSecretInput,
  DeleteVaultSecretInput,
  RevealVaultSecretInput,
  RevealVaultSecretsInput,
  RotateVaultSecretInput,
  VaultAction,
  VaultEnvironment,
  VaultProject,
  VaultResourceReference,
  VaultSecretMetadata,
} from '@qnotes/shared';
import { MAX_VAULT_BATCH_REVEAL, MAX_VAULT_BATCH_BYTES, MAX_VAULT_DESCRIPTION_LENGTH, MAX_VAULT_ENVIRONMENT_NAME_LENGTH, MAX_VAULT_PROJECT_NAME_LENGTH, MAX_VAULT_PURPOSE_LENGTH, MAX_VAULT_SECRET_BYTES, MAX_VAULT_SECRET_NAME_LENGTH } from '@qnotes/shared';
import { toolResult } from './common.ts';
import { vaultEnvironmentsSchema, vaultMetadataSchema, vaultProjectsSchema, vaultSecretBatchSchema, vaultSecretSchema, vaultSecretsSchema } from '../contracts.ts';

export interface VaultMcpClient {
  listProjects(): Promise<VaultProject[]>;
  listEnvironments(project: string): Promise<VaultEnvironment[]>;
  listSecrets(environmentId: string): Promise<VaultSecretMetadata[]>;
  listSecretsBySelector(project: string, environment: string): Promise<VaultSecretMetadata[]>;
  resolveEnvironment(project: string, environment: string, action: VaultAction): Promise<VaultResourceReference>;
  resolveSecret(input: { project: string; environment: string; name: string }, action: VaultAction): Promise<VaultResourceReference>;
  createSecret(input: CreateVaultSecretInput): Promise<VaultSecretMetadata>;
  rotateSecret(secretId: string, input: RotateVaultSecretInput): Promise<VaultSecretMetadata>;
  deleteSecret(secretId: string, input: DeleteVaultSecretInput): Promise<VaultSecretMetadata>;
  revealSecret(input: RevealVaultSecretInput): Promise<unknown>;
  revealSecrets(input: RevealVaultSecretsInput): Promise<unknown>;
}

export const VAULT_METADATA_TOOL_NAMES = ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets'] as const;
export const VAULT_REVEAL_TOOL_NAMES = [...VAULT_METADATA_TOOL_NAMES, 'vault_get_secret', 'vault_get_secrets'] as const;
export const VAULT_WRITE_TOOL_NAMES = [...VAULT_METADATA_TOOL_NAMES, 'vault_create_secret', 'vault_rotate_secret', 'vault_delete_secret'] as const;

type VaultRevealMcpInput = RevealVaultSecretInput & { confirmPlaintext: true };
type VaultBatchRevealMcpInput = RevealVaultSecretsInput & { confirmPlaintext: true };

function listItems<T>(value: T[] | { items: T[] }): T[] {
  return Array.isArray(value) ? value : value.items;
}

export async function vaultListProjectsTool(client: VaultMcpClient) {
  return toolResult({ items: listItems(await client.listProjects()) }, vaultProjectsSchema);
}

export async function vaultListEnvironmentsTool(client: VaultMcpClient, args: { project: string }) {
  return toolResult({ items: listItems(await client.listEnvironments(args.project)) }, vaultEnvironmentsSchema);
}

export async function vaultListSecretsTool(client: VaultMcpClient, args: { project: string; environment: string }) {
  return toolResult({ items: listItems(await client.listSecretsBySelector(args.project, args.environment)) }, vaultSecretsSchema);
}

export async function vaultGetSecretTool(client: VaultMcpClient, args: VaultRevealMcpInput) {
  if (args.confirmPlaintext !== true) throw new Error('confirmPlaintext must be true for Vault reveal.');
  if (!args.purpose?.trim()) throw new Error('purpose is required for Vault reveal.');
  const { confirmPlaintext: _confirmPlaintext, ...input } = args;
  return toolResult(await client.revealSecret(input), vaultSecretSchema);
}

export async function vaultGetSecretsTool(client: VaultMcpClient, args: VaultBatchRevealMcpInput) {
  if (args.confirmPlaintext !== true) throw new Error('confirmPlaintext must be true for Vault reveal.');
  if (!args.purpose?.trim()) throw new Error('purpose is required for Vault reveal.');
  const { confirmPlaintext: _confirmPlaintext, ...input } = args;
  return toolResult(await client.revealSecrets(input), vaultSecretBatchSchema);
}

export async function vaultCreateSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; value: string; description?: string; mutationId: string }) {
  const resource = await client.resolveEnvironment(args.project, args.environment, 'secret:write');
  const input: CreateVaultSecretInput = { projectId: resource.projectId, environmentId: resource.environmentId, name: args.name, value: args.value, ...(args.description === undefined ? {} : { description: args.description }), mutationId: args.mutationId };
  return toolResult(await client.createSecret(input), vaultMetadataSchema);
}

export async function vaultRotateSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; value: string; description?: string; expectedVersion: number; mutationId: string }) {
  const resource = await client.resolveSecret({ project: args.project, environment: args.environment, name: args.name }, 'secret:write');
  if (!resource.secretId) throw new Error('The requested Vault secret was not found.');
  const input: RotateVaultSecretInput = { value: args.value, ...(args.description === undefined ? {} : { description: args.description }), expectedVersion: args.expectedVersion, mutationId: args.mutationId };
  return toolResult(await client.rotateSecret(resource.secretId, input), vaultMetadataSchema);
}

export async function vaultDeleteSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; expectedVersion: number; mutationId: string; confirm: true }) {
  const resource = await client.resolveSecret({ project: args.project, environment: args.environment, name: args.name }, 'secret:delete');
  if (!resource.secretId) throw new Error('The requested Vault secret was not found.');
  return toolResult(await client.deleteSecret(resource.secretId, { expectedVersion: args.expectedVersion, mutationId: args.mutationId, confirm: true }), vaultMetadataSchema);
}

export const vaultToolLimits = {
  projectName: MAX_VAULT_PROJECT_NAME_LENGTH,
  environmentName: MAX_VAULT_ENVIRONMENT_NAME_LENGTH,
  secretName: MAX_VAULT_SECRET_NAME_LENGTH,
  description: MAX_VAULT_DESCRIPTION_LENGTH,
  purpose: MAX_VAULT_PURPOSE_LENGTH,
  secretBytes: MAX_VAULT_SECRET_BYTES,
  batch: MAX_VAULT_BATCH_REVEAL,
  batchBytes: MAX_VAULT_BATCH_BYTES,
};
