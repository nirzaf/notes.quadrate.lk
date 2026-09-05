import type { AppendNoteInput, CreateNoteInput, Note, UpdateNoteInput } from '@qnotes/shared';
import type { CreateNoteOutcome } from '@qnotes/api-client';
import { toolResult, type ReadQNotesClient } from './common.ts';

export interface WriteQNotesClient extends ReadQNotesClient {
  createNote(input: CreateNoteInput): Promise<Note>;
  createNoteDetailed?: (input: CreateNoteInput) => Promise<{ note: Note; outcome: CreateNoteOutcome }>;
  appendNote(noteId: string, input: AppendNoteInput): Promise<Note>;
  updateNote(noteId: string, input: UpdateNoteInput): Promise<Note>;
  getNote(noteRef: string): Promise<Note>;
}

export interface WriteToolOptions {
  deviceId?: string;
}

const MCP_DEVICE_ID = crypto.randomUUID();

function deviceId(args: { deviceId?: string }, options?: WriteToolOptions): string {
  return args.deviceId ?? options?.deviceId ?? MCP_DEVICE_ID;
}

export async function captureNoteTool(client: WriteQNotesClient, args: { title: string; contentMarkdown: string; tags?: string[]; slug?: string; notebookId?: string | null; dedupeKey?: string; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const input: CreateNoteInput = { title: args.title, contentMarkdown: args.contentMarkdown, tags: args.tags ?? [], ...(args.notebookId !== undefined ? { notebookId: args.notebookId } : {}), ...(args.dedupeKey !== undefined ? { dedupeKey: args.dedupeKey } : {}), deviceId: deviceId(args, options), mutationId: args.mutationId ?? crypto.randomUUID() };
  if (args.slug !== undefined) input.slug = args.slug;
  const result = client.createNoteDetailed
    ? await client.createNoteDetailed(input)
    : { note: await client.createNote(input), outcome: 'created' as const };
  return toolResult({ note: result.note, outcome: result.outcome });
}

export async function appendNoteTool(client: WriteQNotesClient, args: { noteId: string; contentMarkdown: string; expectedVersion?: number; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const note = await client.getNote(args.noteId);
  return toolResult(await client.appendNote(args.noteId, {
    contentMarkdown: args.contentMarkdown,
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : { expectedVersion: note.version }),
    deviceId: deviceId(args, options),
    mutationId: args.mutationId ?? crypto.randomUUID(),
  }));
}

export async function updateNoteTool(client: WriteQNotesClient, args: { noteId: string; title: string; slug: string; contentMarkdown: string; tags?: string[]; expectedVersion: number; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const note = args.tags === undefined ? await client.getNote(args.noteId) : null;
  return toolResult(await client.updateNote(args.noteId, {
    title: args.title,
    slug: args.slug,
    contentMarkdown: args.contentMarkdown,
    tags: args.tags ?? note?.tags ?? [],
    expectedVersion: args.expectedVersion,
    deviceId: deviceId(args, options),
    mutationId: args.mutationId ?? crypto.randomUUID(),
  }));
}
