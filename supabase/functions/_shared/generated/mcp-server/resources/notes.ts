import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Notebook, Note } from '@qnotes/shared';
import type { ReadQNotesClient } from '../tools/common.ts';

interface ResourceQNotesClient extends ReadQNotesClient {
  listNotebooks(): Promise<{ items: Notebook[] }>;
  listNotes(params?: { limit?: number }): Promise<{ items: Array<{ id: string; slug: string; title: string }> }>;
  getNote(noteRef: string): Promise<Note>;
}


export function registerNotesResources(server: McpServer, client: ResourceQNotesClient): void {
  server.registerResource('notebooks', 'qnotes://notebooks', { title: 'Quadrate Notes notebooks', mimeType: 'application/json' }, async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.listNotebooks()) }],
  }));

  server.registerResource('notes', new ResourceTemplate('qnotes://notes/{noteId}', { list: async () => {
    const notes = await client.listNotes({ limit: 50 });
    return { resources: notes.items.map((note) => ({ uri: `qnotes://notes/${note.id}`, name: note.title, mimeType: 'application/json' })) };
  } }), { title: 'Quadrate Note', mimeType: 'application/json' }, async (uri: URL, variables: Record<string, string | string[]>) => {
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
}
