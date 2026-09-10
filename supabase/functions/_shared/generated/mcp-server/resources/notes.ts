import { ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesRequest, ListResourcesResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Notebook, Note } from '@qnotes/shared';
import { boundedMcpContentBytes, type ReadQNotesClient } from '../tools/common.ts';

interface ResourceQNotesClient extends ReadQNotesClient {
  listNotebooks(): Promise<{ items: Notebook[] }>;
  listNotes(params?: { cursor?: string; limit?: number }): Promise<{ items: Array<{ id: string; slug: string; title: string }>; nextCursor: string | null }>;
  getNote(noteRef: string, params?: { maxBytes?: number; offset?: number; lineStart?: number; lineEnd?: number; continuation?: string }): Promise<Note>;
}

type RequestHandler = (request: unknown, extra: unknown) => unknown | Promise<unknown>;
type ResourceRequestExtra = { requestId: RequestId };

function numericParam(uri: URL, name: string): number | undefined {
  const value = uri.searchParams.get(name);
  return value === null ? undefined : Number(value);
}

function contentParams(uri: URL) {
  const params: { maxBytes: number; offset?: number; lineStart?: number; lineEnd?: number; continuation?: string } = { maxBytes: boundedMcpContentBytes(numericParam(uri, 'maxBytes')) };
  const offset = numericParam(uri, 'offset');
  const lineStart = numericParam(uri, 'lineStart');
  const lineEnd = numericParam(uri, 'lineEnd');
  const continuation = uri.searchParams.get('continuation');
  if (offset !== undefined) params.offset = offset;
  if (lineStart !== undefined) params.lineStart = lineStart;
  if (lineEnd !== undefined) params.lineEnd = lineEnd;
  if (continuation !== null) params.continuation = continuation;
  return params;
}

function bridgeResourceListPagination(
  server: McpServer,
  requestCursors: Map<RequestId, string | undefined>,
  responseCursors: Map<RequestId, string | undefined>,
): void {
  // SDK 1.30.0's high-level handler invokes the callback but drops its optional nextCursor.
  // Keep the standard callback result for SDKs that forward it, and bridge the current
  // implementation through the underlying request handler when that handler is available.
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  const existingHandler = handlers?.get('resources/list');
  if (!existingHandler) return;

  server.server.removeRequestHandler('resources/list');
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest, extra: ResourceRequestExtra) => {
    requestCursors.set(extra.requestId, request.params?.cursor);
    try {
      const result = await existingHandler(request, extra) as ListResourcesResult;
      const nextCursor = responseCursors.get(extra.requestId);
      return nextCursor === undefined ? result : { ...result, nextCursor };
    } finally {
      requestCursors.delete(extra.requestId);
      responseCursors.delete(extra.requestId);
    }
  });
}


export function registerNotesResources(server: McpServer, client: ResourceQNotesClient): void {
  const requestCursors = new Map<RequestId, string | undefined>();
  const responseCursors = new Map<RequestId, string | undefined>();

  server.registerResource('notebooks', 'qnotes://notebooks', { title: 'QNotes notebooks', mimeType: 'application/json' }, async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.listNotebooks()) }],
  }));

  server.registerResource('notes', new ResourceTemplate('qnotes://notes/{noteId}', { list: async (extra: ResourceRequestExtra) => {
    const cursor = requestCursors.get(extra.requestId);
    const notes = await client.listNotes({ limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    const nextCursor = notes.nextCursor ?? undefined;
    responseCursors.set(extra.requestId, nextCursor);
    return {
      resources: notes.items.map((note) => ({ uri: `qnotes://notes/${note.id}`, name: note.title, mimeType: 'application/json' })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  } }), {
    title: 'Recent QNotes',
    description: 'A recent, partial list of note summaries. Read qnotes://notes/{noteId} for a bounded Markdown page and follow its continuation.',
    mimeType: 'application/json',
  }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const note = await client.getNote(noteId, contentParams(uri));
    if (note.id !== noteId) throw new Error('Resource note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(note) }] };
  });

  server.registerResource('note-document', new ResourceTemplate('qnotes://notes/{noteId}/documents/{documentId}', { list: undefined }), { title: 'QNotes note document context', mimeType: 'application/json' }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const page = contentParams(uri);
    const context = await client.readNoteContext(String(variables.documentId), { before: 1, after: 1, maxTokens: 1800, maxBytes: page.maxBytes, ...(page.continuation === undefined ? {} : { continuation: page.continuation }) });
    if (context.noteId !== noteId) throw new Error('Document context note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(context) }] };
  });

  server.registerResource('note-block', new ResourceTemplate('qnotes://notes/{noteId}/blocks/{blockKey}', { list: undefined }), { title: 'QNotes note block', mimeType: 'application/json' }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const block = await client.getBlock(noteId, String(variables.blockKey), contentParams(uri));
    if (block.noteId !== noteId) throw new Error('Block note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(block) }] };
  });

  bridgeResourceListPagination(server, requestCursors, responseCursors);
}
