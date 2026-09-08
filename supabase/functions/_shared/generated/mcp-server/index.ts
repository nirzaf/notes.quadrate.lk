import { QNotesClient, QVaultClient } from '@qnotes/api-client';
import { isUUID } from '@qnotes/shared';
import { resolveVaultBaseUrl } from './runtime-config.ts';
import { runQNotesMcpServer, type McpProfile, type VaultMcpProfile } from './server.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const profile: McpProfile = process.env.QNOTES_MCP_PROFILE === 'write'
  ? 'write'
  : process.env.QNOTES_MCP_PROFILE === 'share'
    ? 'share'
    : 'read';
const baseUrl = requiredEnvironment('QNOTES_URL');
const vaultBaseUrl = resolveVaultBaseUrl(baseUrl, process.env.QVAULT_URL);
const token = profile === 'write'
  ? requiredEnvironment('QNOTES_WRITE_TOKEN')
  : (process.env.QNOTES_TOKEN ?? requiredEnvironment('QNOTES_READ_TOKEN'));
if (profile === 'share' && !token.startsWith('qnt_')) {
  throw new Error('QNOTES_MCP_PROFILE=share requires QNOTES_TOKEN or QNOTES_READ_TOKEN to be a qnt_ personal token with shares:write.');
}
const configuredDeviceId = process.env.QNOTES_MCP_DEVICE_ID;
if (configuredDeviceId && !isUUID(configuredDeviceId)) throw new Error('QNOTES_MCP_DEVICE_ID must be a UUID. Keep this value stable across MCP process restarts when retrying writes.');
const client = new QNotesClient({ baseUrl, getAccessToken: () => token });
const vaultToken = process.env.QVAULT_TOKEN;
const vaultProfile: VaultMcpProfile | undefined = vaultToken
  ? (process.env.QVAULT_MCP_PROFILE === 'write' ? 'write' : process.env.QVAULT_MCP_PROFILE === 'reveal' ? 'reveal' : 'metadata')
  : undefined;
const vaultClient = vaultToken
  ? new QVaultClient({ baseUrl: vaultBaseUrl, getAccessToken: () => vaultToken })
  : undefined;
await runQNotesMcpServer(client, profile, {
  ...(configuredDeviceId ? { deviceId: configuredDeviceId } : {}),
  ...(vaultClient && vaultProfile ? { vaultClient, vaultProfile } : {}),
});
