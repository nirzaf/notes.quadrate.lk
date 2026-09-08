import { isUUID } from './validation.ts';
import type { UUID } from './contracts.ts';

export type HermesMcpProfile = 'read' | 'share' | 'write';
export type HermesVaultMcpProfile = 'none' | 'metadata' | 'reveal' | 'write';

export interface HermesMcpConfigInput {
  profile: HermesMcpProfile;
  serverPath: string;
  deviceId?: UUID;
  vaultProfile?: HermesVaultMcpProfile;
}

const READ_TOOLS = ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share'];
const SHARE_TOOLS = ['create_public_share'];
const WRITE_TOOLS = ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook'];
const VAULT_METADATA_TOOLS = ['vault_list_projects', 'vault_list_environments', 'vault_list_secrets'];
const VAULT_REVEAL_TOOLS = ['vault_get_secret', 'vault_get_secrets'];
const VAULT_WRITE_TOOLS = ['vault_create_secret', 'vault_rotate_secret', 'vault_delete_secret'];

/**
 * JSON is valid YAML 1.2, so JSON.stringify gives Hermes a safely escaped,
 * copyable config without hand-built YAML interpolation hazards.
 */
export function buildHermesMcpConfig({ profile, serverPath, deviceId, vaultProfile = 'none' }: HermesMcpConfigInput): string {
  if (!serverPath.trim()) throw new Error('serverPath is required.');
  if (profile === 'write' && (!deviceId || !isUUID(deviceId))) throw new Error('A stable UUID deviceId is required for the write profile.');
  const serverName = profile === 'write' ? 'quadrate_notes_write' : profile === 'share' ? 'quadrate_notes_share' : 'quadrate_notes_read';
  const notesTools = profile === 'write' ? [...READ_TOOLS, ...SHARE_TOOLS, ...WRITE_TOOLS] : profile === 'share' ? [...READ_TOOLS, ...SHARE_TOOLS] : READ_TOOLS;
  const vaultTools = vaultProfile === 'write'
    ? [...VAULT_METADATA_TOOLS, ...VAULT_REVEAL_TOOLS, ...VAULT_WRITE_TOOLS]
    : vaultProfile === 'reveal'
      ? [...VAULT_METADATA_TOOLS, ...VAULT_REVEAL_TOOLS]
      : vaultProfile === 'metadata'
        ? VAULT_METADATA_TOOLS
        : [];
  const environment: Record<string, string> = {
    QNOTES_URL: '${QNOTES_URL}',
    ...(profile === 'write'
      ? {
          QNOTES_MCP_PROFILE: 'write',
          QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}',
          QNOTES_MCP_DEVICE_ID: deviceId!,
        }
      : { QNOTES_TOKEN: profile === 'share' ? '${QNOTES_TOKEN}' : '${QNOTES_READ_TOKEN}' }),
    ...(vaultProfile === 'none' ? {} : { QVAULT_TOKEN: '${QVAULT_TOKEN}', QVAULT_MCP_PROFILE: vaultProfile }),
  };
  const server = {
    command: 'node',
    args: [serverPath],
    env: environment,
    connect_timeout: 10,
    timeout: 45,
    supports_parallel_tool_calls: profile === 'read' && (vaultProfile === 'none' || vaultProfile === 'metadata'),
    tools: { include: [...notesTools, ...vaultTools] },
    prompts: false,
  };
  return JSON.stringify({ mcp_servers: { [serverName]: server } }, null, 2);
}
