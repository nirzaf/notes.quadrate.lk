import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { QNotesClient } from '@qnotes/api-client';
import { getBlockTool } from './tools/get-block.js';
import { readNoteContextTool } from './tools/read-note-context.js';
import { searchNotesTool } from './tools/search-notes.js';
import type { ReadQNotesClient } from './tools/common.js';
import { registerNotesResources } from './resources/notes.js';
import { appendNoteTool } from './tools/append-note.js';
import { captureNoteTool, type WriteQNotesClient } from './tools/capture-note.js';
import { updateNoteTool } from './tools/update-note.js';

export type McpProfile = 'read' | 'write';
export const READ_TOOL_NAMES = ['search_notes', 'read_note_context', 'get_block'] as const;
export const WRITE_TOOL_NAMES = ['capture_note', 'append_note', 'update_note'] as const;

export function createQNotesMcpServer(client: QNotesClient & ReadQNotesClient, profile: McpProfile = 'read'): McpServer {
  const server = new McpServer(
    { name: 'quadrate-notes', version: '0.1.0' },
    { instructions: 'Search first, then read bounded note context. Full note reads are explicit.' },
  );
  server.registerTool('search_notes', {
    description: 'Search Quadrate Notes and return compact ranked document candidates.',
    inputSchema: {
      query: z.string().min(1).max(500),
      mode: z.enum(['auto', 'keyword', 'semantic', 'hybrid']).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => searchNotesTool(client, args as Parameters<typeof searchNotesTool>[1]));
  server.registerTool('read_note_context', {
    description: 'Read one exact search document with bounded neighboring context.',
    inputSchema: {
      documentId: z.string().uuid(),
      before: z.number().int().min(0).max(5).optional(),
      after: z.number().int().min(0).max(5).optional(),
      maxTokens: z.number().int().min(1).max(4000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => readNoteContextTool(client, args as Parameters<typeof readNoteContextTool>[1]));
  server.registerTool('get_block', {
    description: 'Read one exact reusable code or copy block by note reference and block key.',
    inputSchema: {
      noteRef: z.string().min(1).max(200),
      blockKey: z.string().min(1).max(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => getBlockTool(client, args));
  registerNotesResources(server, client);
  if (profile === 'write') {
    const writeClient = client as QNotesClient & WriteQNotesClient;
    server.registerTool('capture_note', {
      description: 'Create one note using an explicit idempotent mutation ID.',
      inputSchema: {
        title: z.string().min(1).max(500),
        contentMarkdown: z.string().max(2_000_000),
        tags: z.array(z.string().min(1).max(80)).max(50).optional(),
        slug: z.string().min(1).max(200).optional(),
        deviceId: z.string().uuid(),
        mutationId: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args) => captureNoteTool(writeClient, args as Parameters<typeof captureNoteTool>[1]));
    server.registerTool('append_note', {
      description: 'Append content with an optimistic versioned update.',
      inputSchema: {
        noteId: z.string().uuid(),
        contentMarkdown: z.string().min(1).max(2_000_000),
        deviceId: z.string().uuid(),
        mutationId: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args) => appendNoteTool(writeClient, args as Parameters<typeof appendNoteTool>[1]));
    server.registerTool('update_note', {
      description: 'Replace one note using an explicit expected version and mutation ID.',
      inputSchema: {
        noteId: z.string().uuid(),
        title: z.string().min(1).max(500),
        slug: z.string().min(1).max(200),
        contentMarkdown: z.string().max(2_000_000),
        tags: z.array(z.string().min(1).max(80)).max(50).optional(),
        expectedVersion: z.number().int().min(1),
        deviceId: z.string().uuid(),
        mutationId: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args) => updateNoteTool(writeClient, args as Parameters<typeof updateNoteTool>[1]));
  }
  return server;
}

export async function runQNotesMcpServer(client: QNotesClient & ReadQNotesClient, profile: McpProfile = 'read'): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await createQNotesMcpServer(client, profile).connect(new StdioServerTransport());
}
