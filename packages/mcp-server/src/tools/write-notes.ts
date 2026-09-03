import type { CreateNoteInput, Note, UpdateNoteInput } from '@qnotes/shared';
import { toolResult, type ReadQNotesClient } from './common.js';

export interface WriteQNotesClient extends ReadQNotesClient {
  createNote(input: CreateNoteInput): Promise<Note>;
  updateNote(noteId: string, input: UpdateNoteInput): Promise<Note>;
  getNote(noteRef: string): Promise<Note>;
}

export async function captureNoteTool(client: WriteQNotesClient, args: { title: string; contentMarkdown: string; tags?: string[]; slug?: string; deviceId: string; mutationId: string }) {
  const input: CreateNoteInput = { title: args.title, contentMarkdown: args.contentMarkdown, tags: args.tags ?? [], deviceId: args.deviceId, mutationId: args.mutationId };
  if (args.slug !== undefined) input.slug = args.slug;
  return toolResult(await client.createNote(input));
}

export async function appendNoteTool(client: WriteQNotesClient, args: { noteId: string; contentMarkdown: string; deviceId: string; mutationId: string }) {
  const note = await client.getNote(args.noteId);
  const contentMarkdown = note.contentMarkdown.trim() ? `${note.contentMarkdown.trim()}\n\n${args.contentMarkdown.trim()}` : args.contentMarkdown.trim();
  return toolResult(await client.updateNote(args.noteId, {
    title: note.title,
    slug: note.slug,
    contentMarkdown,
    tags: note.tags,
    expectedVersion: note.version,
    deviceId: args.deviceId,
    mutationId: args.mutationId,
  }));
}

export async function updateNoteTool(client: WriteQNotesClient, args: { noteId: string; title: string; slug: string; contentMarkdown: string; tags?: string[]; expectedVersion: number; deviceId: string; mutationId: string }) {
  return toolResult(await client.updateNote(args.noteId, {
    title: args.title,
    slug: args.slug,
    contentMarkdown: args.contentMarkdown,
    tags: args.tags ?? [],
    expectedVersion: args.expectedVersion,
    deviceId: args.deviceId,
    mutationId: args.mutationId,
  }));
}
