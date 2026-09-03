import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { QNotesClient } from '@qnotes/api-client';
import { MAX_BLOCK_KEY_LENGTH, MAX_DEDUPE_KEY_LENGTH, MAX_MARKDOWN_CODE_UNITS, MAX_SEARCH_LIMIT, MAX_SEARCH_QUERY_LENGTH, MAX_SLUG_LENGTH, MAX_TAG_COUNT, MAX_TAG_LENGTH, MAX_TITLE_LENGTH } from '@qnotes/shared';
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
      query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
      mode: z.enum(['auto', 'keyword', 'semantic', 'hybrid']).optional(),
      limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
      filters: z.object({
        notebookIds: z.array(z.string().uuid()).max(50).optional(),
      tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAG_COUNT).optional(),
        sourceTypes: z.array(z.enum(['note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk'])).max(5).optional(),
        languages: z.array(z.string().min(1).max(40)).max(50).optional(),
        updatedAfter: z.string().datetime().optional(),
        unfiled: z.boolean().optional(),
      }).optional(),
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
      blockKey: z.string().min(1).max(MAX_BLOCK_KEY_LENGTH),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => getBlockTool(client, args));
  registerNotesResources(server, client);
  if (profile === 'write') {
    const writeClient = client as QNotesClient & WriteQNotesClient;
    server.registerTool('capture_note', {
      description: 'Create one note with process-scoped idempotency and optional notebook/dedupe provenance.',
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        contentMarkdown: z.string().max(MAX_MARKDOWN_CODE_UNITS),
        tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAG_COUNT).optional(),
        slug: z.string().min(1).max(MAX_SLUG_LENGTH).optional(),
        notebookId: z.string().uuid().nullable().optional(),
        dedupeKey: z.string().min(1).max(MAX_DEDUPE_KEY_LENGTH).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args) => captureNoteTool(writeClient, args as Parameters<typeof captureNoteTool>[1]));
    server.registerTool('append_note', {
      description: 'Append content with an optimistic versioned update while preserving Markdown boundaries.',
      inputSchema: {
        noteId: z.string().uuid(),
        contentMarkdown: z.string().min(1).max(MAX_MARKDOWN_CODE_UNITS),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args) => appendNoteTool(writeClient, args as Parameters<typeof appendNoteTool>[1]));
    server.registerTool('update_note', {
      description: 'Replace one note using an explicit expected version while preserving omitted tags.',
      inputSchema: {
        noteId: z.string().uuid(),
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        slug: z.string().min(1).max(MAX_SLUG_LENGTH),
        contentMarkdown: z.string().max(MAX_MARKDOWN_CODE_UNITS),
        tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAG_COUNT).optional(),
        expectedVersion: z.number().int().min(1),
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
