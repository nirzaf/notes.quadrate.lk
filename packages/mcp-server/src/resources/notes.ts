import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Notebook, Note } from '@qnotes/shared';
import type { ReadQNotesClient } from '../tools/common.js';

interface ResourceQNotesClient extends ReadQNotesClient {
  listNotebooks(): Promise<{ items: Notebook[] }>;
  listNotes(params?: { limit?: number }): Promise<{ items: Array<{ id: string; slug: string; title: string }> }>;
  getNote(noteRef: string): Promise<Note>;
}


export function registerNotesResources(server: McpServer, client: ResourceQNotesClient): void {
  server.registerResource('notebooks', 'qnotes://notebooks', { title: 'Quadrate Notes notebooks', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.listNotebooks()) }],
  }));

  server.registerResource('notes', new ResourceTemplate('qnotes://notes/{noteId}', { list: async () => {
    const notes = await client.listNotes({ limit: 50 });
    return { resources: notes.items.map((note) => ({ uri: `qnotes://notes/${note.id}`, name: note.title, mimeType: 'application/json' })) };
  } }), { title: 'Quadrate Note', mimeType: 'application/json' }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.getNote(String(variables.noteId))) }],
  }));

  server.registerResource('note-document', new ResourceTemplate('qnotes://notes/{noteId}/documents/{documentId}', { list: undefined }), { title: 'Quadrate Note document context', mimeType: 'application/json' }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.readNoteContext(String(variables.documentId))) }],
  }));

  server.registerResource('note-block', new ResourceTemplate('qnotes://notes/{noteId}/blocks/{blockKey}', { list: undefined }), { title: 'Quadrate Note block', mimeType: 'application/json' }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await client.getBlock(String(variables.noteId), String(variables.blockKey))) }],
  }));
}
