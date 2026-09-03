import type { CreateNoteInput, Note, UpdateNoteInput } from '@qnotes/shared';
import type { CreateNoteOutcome } from '@qnotes/api-client';
import { appendMarkdown, toolResult, type ReadQNotesClient } from './common.js';
import { randomUUID } from 'node:crypto';

export interface WriteQNotesClient extends ReadQNotesClient {
  createNote(input: CreateNoteInput): Promise<Note>;
  createNoteDetailed?: (input: CreateNoteInput) => Promise<{ note: Note; outcome: CreateNoteOutcome }>;
  updateNote(noteId: string, input: UpdateNoteInput): Promise<Note>;
  getNote(noteRef: string): Promise<Note>;
}

const MCP_DEVICE_ID = randomUUID();

export async function captureNoteTool(client: WriteQNotesClient, args: { title: string; contentMarkdown: string; tags?: string[]; slug?: string; notebookId?: string | null; dedupeKey?: string; deviceId?: string; mutationId?: string }) {
  const input: CreateNoteInput = { title: args.title, contentMarkdown: args.contentMarkdown, tags: args.tags ?? [], ...(args.notebookId !== undefined ? { notebookId: args.notebookId } : {}), ...(args.dedupeKey !== undefined ? { dedupeKey: args.dedupeKey } : {}), deviceId: args.deviceId ?? MCP_DEVICE_ID, mutationId: args.mutationId ?? randomUUID() };
  if (args.slug !== undefined) input.slug = args.slug;
  const result = client.createNoteDetailed
    ? await client.createNoteDetailed(input)
    : { note: await client.createNote(input), outcome: 'created' as const };
  return toolResult({ note: result.note, outcome: result.outcome });
}

export async function appendNoteTool(client: WriteQNotesClient, args: { noteId: string; contentMarkdown: string; deviceId?: string; mutationId?: string }) {
  const note = await client.getNote(args.noteId);
  const contentMarkdown = appendMarkdown(note.contentMarkdown, args.contentMarkdown);
  return toolResult(await client.updateNote(args.noteId, {
    title: note.title,
    slug: note.slug,
    contentMarkdown,
    tags: note.tags,
    expectedVersion: note.version,
    deviceId: args.deviceId ?? MCP_DEVICE_ID,
    mutationId: args.mutationId ?? randomUUID(),
  }));
}

export async function updateNoteTool(client: WriteQNotesClient, args: { noteId: string; title: string; slug: string; contentMarkdown: string; tags?: string[]; expectedVersion: number; deviceId?: string; mutationId?: string }) {
  const note = args.tags === undefined ? await client.getNote(args.noteId) : null;
  return toolResult(await client.updateNote(args.noteId, {
    title: args.title,
    slug: args.slug,
    contentMarkdown: args.contentMarkdown,
    tags: args.tags ?? note?.tags ?? [],
    expectedVersion: args.expectedVersion,
    deviceId: args.deviceId ?? MCP_DEVICE_ID,
    mutationId: args.mutationId ?? randomUUID(),
  }));
}
