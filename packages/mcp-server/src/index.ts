import { QNotesClient } from '@qnotes/api-client';
import { isUUID } from '@qnotes/shared';
import { runQNotesMcpServer, type McpProfile } from './server.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const profile: McpProfile = process.env.QNOTES_MCP_PROFILE === 'write' ? 'write' : 'read';
const baseUrl = requiredEnvironment('QNOTES_URL');
const token = profile === 'write' ? requiredEnvironment('QNOTES_WRITE_TOKEN') : (process.env.QNOTES_TOKEN ?? requiredEnvironment('QNOTES_READ_TOKEN'));
const configuredDeviceId = process.env.QNOTES_MCP_DEVICE_ID;
if (configuredDeviceId && !isUUID(configuredDeviceId)) throw new Error('QNOTES_MCP_DEVICE_ID must be a UUID. Keep this value stable across MCP process restarts when retrying writes.');
const client = new QNotesClient({ baseUrl, getAccessToken: () => token });

await runQNotesMcpServer(client, profile, configuredDeviceId ? { deviceId: configuredDeviceId } : {});
