import type {
  CreateVaultSecretInput,
  DeleteVaultSecretInput,
  RevealVaultSecretInput,
  RevealVaultSecretsInput,
  RotateVaultSecretInput,
  VaultEnvironment,
  VaultProject,
  VaultSecretMetadata,
} from '@qnotes/shared';
import { MAX_VAULT_BATCH_REVEAL, MAX_VAULT_BATCH_BYTES, MAX_VAULT_DESCRIPTION_LENGTH, MAX_VAULT_ENVIRONMENT_NAME_LENGTH, MAX_VAULT_PROJECT_NAME_LENGTH, MAX_VAULT_PURPOSE_LENGTH, MAX_VAULT_SECRET_BYTES, MAX_VAULT_SECRET_NAME_LENGTH } from '@qnotes/shared';
import { toolResult } from './common.ts';

export interface VaultMcpClient {
  listProjects(): Promise<VaultProject[]>;
  listEnvironments(project: string): Promise<VaultEnvironment[]>;
  listSecrets(environmentId: string): Promise<VaultSecretMetadata[]>;
  createSecret(input: CreateVaultSecretInput): Promise<VaultSecretMetadata>;
  rotateSecret(secretId: string, input: RotateVaultSecretInput): Promise<VaultSecretMetadata>;
  deleteSecret(secretId: string, input: DeleteVaultSecretInput): Promise<VaultSecretMetadata>;
  revealSecret(input: RevealVaultSecretInput): Promise<unknown>;
  revealSecrets(input: RevealVaultSecretsInput): Promise<unknown>;
}

export const VAULT_METADATA_TOOL_NAMES = ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets'] as const;
export const VAULT_REVEAL_TOOL_NAMES = [...VAULT_METADATA_TOOL_NAMES, 'vault_get_secret', 'vault_get_secrets'] as const;
export const VAULT_WRITE_TOOL_NAMES = [...VAULT_REVEAL_TOOL_NAMES, 'vault_create_secret', 'vault_rotate_secret', 'vault_delete_secret'] as const;

export async function vaultListProjectsTool(client: VaultMcpClient) {
  return toolResult(await client.listProjects());
}

export async function vaultListEnvironmentsTool(client: VaultMcpClient, args: { project: string }) {
  return toolResult(await client.listEnvironments(args.project));
}

async function findEnvironment(client: VaultMcpClient, project: string, environment: string): Promise<VaultEnvironment> {
  const environments = await client.listEnvironments(project);
  const found = environments.find((item) => item.slug === environment || item.name === environment);
  if (!found) throw new Error('The requested Vault environment was not found.');
  return found;
}

async function findSecret(client: VaultMcpClient, project: string, environment: string, name: string): Promise<VaultSecretMetadata> {
  const environmentRecord = await findEnvironment(client, project, environment);
  const secrets = await client.listSecrets(environmentRecord.id);
  const found = secrets.find((item) => item.name === name);
  if (!found) throw new Error('The requested Vault secret was not found.');
  return found;
}

export async function vaultListSecretsTool(client: VaultMcpClient, args: { project: string; environment: string }) {
  const environment = await findEnvironment(client, args.project, args.environment);
  return toolResult(await client.listSecrets(environment.id));
}

export async function vaultGetSecretTool(client: VaultMcpClient, args: RevealVaultSecretInput) {
  if (!args.purpose?.trim()) throw new Error('purpose is required for Vault reveal.');
  return toolResult(await client.revealSecret(args));
}

export async function vaultGetSecretsTool(client: VaultMcpClient, args: RevealVaultSecretsInput) {
  if (!args.purpose?.trim()) throw new Error('purpose is required for Vault reveal.');
  return toolResult(await client.revealSecrets(args));
}

export async function vaultCreateSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; value: string; description?: string; mutationId: string }) {
  const environment = await findEnvironment(client, args.project, args.environment);
  const input: CreateVaultSecretInput = { projectId: environment.projectId, environmentId: environment.id, name: args.name, value: args.value, ...(args.description === undefined ? {} : { description: args.description }), mutationId: args.mutationId };
  return toolResult(await client.createSecret(input));
}

export async function vaultRotateSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; value: string; description?: string; expectedVersion: number; mutationId: string }) {
  const secret = await findSecret(client, args.project, args.environment, args.name);
  const input: RotateVaultSecretInput = { value: args.value, ...(args.description === undefined ? {} : { description: args.description }), expectedVersion: args.expectedVersion, mutationId: args.mutationId };
  return toolResult(await client.rotateSecret(secret.id, input));
}

export async function vaultDeleteSecretTool(client: VaultMcpClient, args: { project: string; environment: string; name: string; expectedVersion: number; mutationId: string; confirm: true }) {
  const secret = await findSecret(client, args.project, args.environment, args.name);
  return toolResult(await client.deleteSecret(secret.id, { expectedVersion: args.expectedVersion, mutationId: args.mutationId, confirm: true }));
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
