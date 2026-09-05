import { isUUID } from './validation.ts';
import type { UUID } from './contracts.ts';

export type HermesMcpProfile = 'read' | 'write';

export interface HermesMcpConfigInput {
  profile: HermesMcpProfile;
  serverPath: string;
  deviceId?: UUID;
}

const READ_TOOLS = ['search_notes', 'read_note_context', 'get_block'];
const WRITE_TOOLS = ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note'];

/**
 * JSON is valid YAML 1.2, so JSON.stringify gives Hermes a safely escaped,
 * copyable config without hand-built YAML interpolation hazards.
 */
export function buildHermesMcpConfig({ profile, serverPath, deviceId }: HermesMcpConfigInput): string {
  if (!serverPath.trim()) throw new Error('serverPath is required.');
  if (profile === 'write' && (!deviceId || !isUUID(deviceId))) throw new Error('A stable UUID deviceId is required for the write profile.');
  const serverName = profile === 'write' ? 'quadrate_notes_write' : 'quadrate_notes_read';
  const environment: Record<string, string> = {
    QNOTES_URL: '${QNOTES_URL}',
    ...(profile === 'write'
      ? {
          QNOTES_MCP_PROFILE: 'write',
          QNOTES_WRITE_TOKEN: '${QNOTES_WRITE_TOKEN}',
          QNOTES_MCP_DEVICE_ID: deviceId!,
        }
      : { QNOTES_TOKEN: '${QNOTES_READ_TOKEN}' }),
  };
  const server = {
    command: 'node',
    args: [serverPath],
    env: environment,
    connect_timeout: 10,
    timeout: 20,
    supports_parallel_tool_calls: profile === 'read',
    tools: { include: profile === 'write' ? WRITE_TOOLS : READ_TOOLS },
    prompts: false,
  };
  return JSON.stringify({ mcp_servers: { [serverName]: server } }, null, 2);
}
