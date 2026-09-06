import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { QNotesClient } from '@qnotes/api-client';
import { MAX_BLOCK_KEY_LENGTH, MAX_DEDUPE_KEY_LENGTH, MAX_MARKDOWN_CODE_UNITS, MAX_SEARCH_CURSOR_LENGTH, MAX_SEARCH_LIMIT, MAX_SEARCH_QUERY_LENGTH, MAX_SLUG_LENGTH, MAX_TAG_COUNT, MAX_TAG_LENGTH, MAX_TITLE_LENGTH } from '@qnotes/shared';
import { getBlockTool } from './tools/get-block.ts';
import { readNoteContextTool } from './tools/read-note-context.ts';
import { resolvePublicShareTool } from './tools/resolve-public-share.ts';
import { searchNotesTool } from './tools/search-notes.ts';
import { toolResult, type ReadQNotesClient } from './tools/common.ts';
import { registerNotesResources } from './resources/notes.ts';
import { appendNoteTool } from './tools/append-note.ts';
import { captureNoteTool, type WriteQNotesClient } from './tools/capture-note.ts';
import { deleteNoteTool } from './tools/delete-note.ts';
import { restoreNoteTool } from './tools/restore-note.ts';
import type { WriteToolOptions } from './tools/write-notes.ts';
import { moveNoteToNotebookTool, updateNoteTool } from './tools/write-notes.ts';

export type McpProfile = 'read' | 'write';
export const READ_TOOL_NAMES = ['search_notes', 'read_note_context', 'get_block', 'list_notebooks', 'resolve_public_share'] as const;
export const WRITE_TOOL_NAMES = ['capture_note', 'append_note', 'update_note', 'delete_note', 'restore_note', 'move_note_to_notebook'] as const;
export interface QNotesMcpServerOptions extends WriteToolOptions {}

const noteAcknowledgmentFields = {
  noteId: z.string().min(1),
  title: z.string(),
  resultingVersion: z.number().int().min(1),
  mutationId: z.string().uuid(),
  uri: z.string().startsWith('qnotes://notes/'),
};
const captureAcknowledgmentSchema = { ...noteAcknowledgmentFields, outcome: z.enum(['created', 'idempotent', 'deduplicated']) };
const mutationAcknowledgmentSchema = { ...noteAcknowledgmentFields, outcome: z.enum(['applied', 'idempotent']) };

export function createQNotesMcpServer(client: QNotesClient & ReadQNotesClient, profile: McpProfile = 'read', options: QNotesMcpServerOptions = {}): McpServer {
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
      cursor: z.string().min(1).max(MAX_SEARCH_CURSOR_LENGTH).optional(),
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
  }, (args: Record<string, unknown>) => searchNotesTool(client, args as Parameters<typeof searchNotesTool>[1]));
  server.registerTool('read_note_context', {
    description: 'Read one exact search document with bounded neighboring context.',
    inputSchema: {
      documentId: z.string().uuid(),
      before: z.number().int().min(0).max(5).optional(),
      after: z.number().int().min(0).max(5).optional(),
      maxTokens: z.number().int().min(1).max(4000).optional(),
      continuation: z.string().max(8192).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: Record<string, unknown>) => readNoteContextTool(client, args as Parameters<typeof readNoteContextTool>[1]));
  server.registerTool('get_block', {
    description: 'Read one exact reusable code or copy block by note reference and block key.',
    inputSchema: {
      noteRef: z.string().min(1).max(200),
      blockKey: z.string().min(1).max(MAX_BLOCK_KEY_LENGTH),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: Record<string, unknown>) => getBlockTool(client, args as Parameters<typeof getBlockTool>[1]));
  server.registerTool('list_notebooks', {
    description: 'List available Quadrate Notes notebooks without reading note contents.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => toolResult(await client.listNotebooks()));
  server.registerTool('resolve_public_share', {
    description: 'Fetch one explicitly shared Quadrate Notes note by its qns_... bearer secret. Returns only the public title, saved Markdown, and update timestamp.',
    inputSchema: {
      token: z.string().regex(/^qns_[A-Za-z0-9_-]{43}$/),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: Record<string, unknown>) => resolvePublicShareTool(client, args as Parameters<typeof resolvePublicShareTool>[1]));
  registerNotesResources(server, client);
  if (profile === 'write') {
    const writeClient = client as QNotesClient & WriteQNotesClient;
    server.registerTool('capture_note', {
      description: 'Create one note. For an ambiguous retry, pass the same mutationId; omitted mutationId values are fresh operations.',
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        contentMarkdown: z.string().max(MAX_MARKDOWN_CODE_UNITS),
        tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAG_COUNT).optional(),
        slug: z.string().min(1).max(MAX_SLUG_LENGTH).optional(),
        notebookId: z.string().uuid().nullable().optional(),
        dedupeKey: z.string().min(1).max(MAX_DEDUPE_KEY_LENGTH).optional(),
        mutationId: z.string().uuid().optional(),
      },
      outputSchema: captureAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => captureNoteTool(writeClient, args as Parameters<typeof captureNoteTool>[1], options));
    server.registerTool('append_note', {
      description: 'Append content as one logical operation. Retry an ambiguous result with the same mutationId; keep QNOTES_MCP_DEVICE_ID stable across process restarts for durable receipt identity.',
      inputSchema: {
        noteId: z.string().uuid(),
        contentMarkdown: z.string().max(MAX_MARKDOWN_CODE_UNITS),
        expectedVersion: z.number().int().min(1).optional(),
        mutationId: z.string().uuid().optional(),
      },
      outputSchema: mutationAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => appendNoteTool(writeClient, args as Parameters<typeof appendNoteTool>[1], options));
    server.registerTool('update_note', {
      description: 'Replace one note using an explicit expected version while preserving omitted tags.',
      inputSchema: {
        noteId: z.string().uuid(),
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        slug: z.string().min(1).max(MAX_SLUG_LENGTH),
        contentMarkdown: z.string().max(MAX_MARKDOWN_CODE_UNITS),
        tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAG_COUNT).optional(),
        expectedVersion: z.number().int().min(1),
        mutationId: z.string().uuid().optional(),
      },
      outputSchema: mutationAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => updateNoteTool(writeClient, args as Parameters<typeof updateNoteTool>[1], options));
    server.registerTool('delete_note', {
      description: 'Soft-delete one exact note after an explicit confirmation and expected-version check. There is no permanent purge operation.',
      inputSchema: {
        noteId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
        mutationId: z.string().uuid().optional(),
        confirm: z.literal(true),
      },
      outputSchema: mutationAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => deleteNoteTool(writeClient, args as Parameters<typeof deleteNoteTool>[1], options));
    server.registerTool('restore_note', {
      description: 'Restore one exact soft-deleted note after an explicit confirmation and expected-version check.',
      inputSchema: {
        noteId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
        mutationId: z.string().uuid().optional(),
        confirm: z.literal(true),
      },
      outputSchema: mutationAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => restoreNoteTool(writeClient, args as Parameters<typeof restoreNoteTool>[1], options));
    server.registerTool('move_note_to_notebook', {
      description: 'Move one note to a notebook, or set notebookId to null to unfile it, using an explicit expected version and replay-safe mutation identity.',
      inputSchema: {
        noteId: z.string().uuid(),
        notebookId: z.string().uuid().nullable(),
        expectedVersion: z.number().int().min(1),
        mutationId: z.string().uuid().optional(),
      },
      outputSchema: mutationAcknowledgmentSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, (args: Record<string, unknown>) => moveNoteToNotebookTool(writeClient, args as Parameters<typeof moveNoteToNotebookTool>[1], options));
  }
  return server;
}

export async function runQNotesMcpServer(client: QNotesClient & ReadQNotesClient, profile: McpProfile = 'read', options: QNotesMcpServerOptions = {}): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await createQNotesMcpServer(client, profile, options).connect(new StdioServerTransport());
}
