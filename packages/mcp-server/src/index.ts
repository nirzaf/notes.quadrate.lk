import { QNotesClient } from '@qnotes/api-client';
import { runQNotesMcpServer, type McpProfile } from './server.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const profile: McpProfile = process.env.QNOTES_MCP_PROFILE === 'write' ? 'write' : 'read';
const baseUrl = requiredEnvironment('QNOTES_URL');
const token = profile === 'write' ? requiredEnvironment('QNOTES_WRITE_TOKEN') : (process.env.QNOTES_TOKEN ?? requiredEnvironment('QNOTES_READ_TOKEN'));
const client = new QNotesClient({ baseUrl, getAccessToken: () => token });

await runQNotesMcpServer(client, profile);
