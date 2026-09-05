import { ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesRequest, ListResourcesResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Notebook, Note } from '@qnotes/shared';
import type { ReadQNotesClient } from '../tools/common.ts';

interface ResourceQNotesClient extends ReadQNotesClient {
  listNotebooks(): Promise<{ items: Notebook[] }>;
  listNotes(params?: { cursor?: string; limit?: number }): Promise<{ items: Array<{ id: string; slug: string; title: string }>; nextCursor: string | null }>;
  getNote(noteRef: string): Promise<Note>;
}

type RequestHandler = (request: unknown, extra: unknown) => unknown | Promise<unknown>;
type ResourceRequestExtra = { requestId: RequestId };

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

  server.registerResource('notebooks', 'qnotes://notebooks', { title: 'Quadrate Notes notebooks', mimeType: 'application/json' }, async (uri: URL) => ({
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
    title: 'Recent Quadrate Notes',
    description: 'A recent, partial list of note summaries. Read qnotes://notes/{noteId} for the full note.',
    mimeType: 'application/json',
  }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const note = await client.getNote(noteId);
    if (note.id !== noteId) throw new Error('Resource note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(note) }] };
  });

  server.registerResource('note-document', new ResourceTemplate('qnotes://notes/{noteId}/documents/{documentId}', { list: undefined }), { title: 'Quadrate Note document context', mimeType: 'application/json' }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const context = await client.readNoteContext(String(variables.documentId));
    if (context.noteId !== noteId) throw new Error('Document context note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(context) }] };
  });

  server.registerResource('note-block', new ResourceTemplate('qnotes://notes/{noteId}/blocks/{blockKey}', { list: undefined }), { title: 'Quadrate Note block', mimeType: 'application/json' }, async (uri: URL, variables: Record<string, string | string[]>) => {
    const noteId = String(variables.noteId);
    const block = await client.getBlock(noteId, String(variables.blockKey));
    if (block.noteId !== noteId) throw new Error('Block note ID does not match the requested URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(block) }] };
  });

  bridgeResourceListPagination(server, requestCursors, responseCursors);
}
