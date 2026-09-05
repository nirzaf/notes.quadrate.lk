import type { AppendNoteInput, CreateNoteInput, Note, UpdateNoteInput } from '@qnotes/shared';
import type { CreateNoteOutcome, NoteMutationOutcome, NoteMutationResult } from '@qnotes/api-client';
import { toolResult, type ReadQNotesClient } from './common.ts';

export interface WriteQNotesClient extends ReadQNotesClient {
  createNote(input: CreateNoteInput): Promise<Note>;
  createNoteDetailed?: (input: CreateNoteInput) => Promise<{ note: Note; outcome: CreateNoteOutcome }>;
  appendNote(noteId: string, input: AppendNoteInput): Promise<Note>;
  appendNoteDetailed?: (noteId: string, input: AppendNoteInput) => Promise<NoteMutationResult>;
  updateNote(noteId: string, input: UpdateNoteInput): Promise<Note>;
  updateNoteDetailed?: (noteId: string, input: UpdateNoteInput) => Promise<NoteMutationResult>;
  deleteNote(noteId: string, input: { expectedVersion: number; deviceId: string; mutationId: string }): Promise<Note>;
  deleteNoteDetailed?: (noteId: string, input: { expectedVersion: number; deviceId: string; mutationId: string }) => Promise<NoteMutationResult>;
  restoreNote(noteId: string, input: { expectedVersion: number; deviceId: string; mutationId: string }): Promise<Note>;
  restoreNoteDetailed?: (noteId: string, input: { expectedVersion: number; deviceId: string; mutationId: string }) => Promise<NoteMutationResult>;
  getNote(noteRef: string): Promise<Note>;
}

export interface WriteToolOptions {
  deviceId?: string;
}

const MCP_DEVICE_ID = crypto.randomUUID();

function deviceId(args: { deviceId?: string }, options?: WriteToolOptions): string {
  return args.deviceId ?? options?.deviceId ?? MCP_DEVICE_ID;
}

export interface MutationAcknowledgment {
  noteId: string;
  title: string;
  resultingVersion: number;
  mutationId: string;
  outcome: CreateNoteOutcome | NoteMutationOutcome;
  uri: string;
}

function acknowledgment(note: Note, mutationId: string, outcome: MutationAcknowledgment['outcome']): MutationAcknowledgment {
  return {
    noteId: note.id,
    title: note.title,
    resultingVersion: note.version,
    mutationId,
    outcome,
    uri: `qnotes://notes/${note.id}`,
  };
}

export async function captureNoteTool(client: WriteQNotesClient, args: { title: string; contentMarkdown: string; tags?: string[]; slug?: string; notebookId?: string | null; dedupeKey?: string; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const mutationId = args.mutationId ?? crypto.randomUUID();
  const input: CreateNoteInput = { title: args.title, contentMarkdown: args.contentMarkdown, tags: args.tags ?? [], ...(args.notebookId !== undefined ? { notebookId: args.notebookId } : {}), ...(args.dedupeKey !== undefined ? { dedupeKey: args.dedupeKey } : {}), deviceId: deviceId(args, options), mutationId };
  if (args.slug !== undefined) input.slug = args.slug;
  const result = client.createNoteDetailed
    ? await client.createNoteDetailed(input)
    : { note: await client.createNote(input), outcome: 'created' as const };
  return toolResult(acknowledgment(result.note, mutationId, result.outcome));
}

export async function appendNoteTool(client: WriteQNotesClient, args: { noteId: string; contentMarkdown: string; expectedVersion?: number; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const mutationId = args.mutationId ?? crypto.randomUUID();
  const input: AppendNoteInput = {
    contentMarkdown: args.contentMarkdown,
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
    deviceId: deviceId(args, options),
    mutationId,
  };
  const result = client.appendNoteDetailed
    ? await client.appendNoteDetailed(args.noteId, input)
    : { note: await client.appendNote(args.noteId, input), outcome: 'applied' as const };
  return toolResult(acknowledgment(result.note, mutationId, result.outcome));
}

export async function updateNoteTool(client: WriteQNotesClient, args: { noteId: string; title: string; slug: string; contentMarkdown: string; tags?: string[]; expectedVersion: number; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  const mutationId = args.mutationId ?? crypto.randomUUID();
  const input: UpdateNoteInput = {
    title: args.title,
    slug: args.slug,
    contentMarkdown: args.contentMarkdown,
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    expectedVersion: args.expectedVersion,
    deviceId: deviceId(args, options),
    mutationId,
  };
  const result = client.updateNoteDetailed
    ? await client.updateNoteDetailed(args.noteId, input)
    : { note: await client.updateNote(args.noteId, input), outcome: 'applied' as const };
  return toolResult(acknowledgment(result.note, mutationId, result.outcome));
}

function requireConfirmation(confirm: boolean): void {
  if (confirm !== true) throw new Error('confirm must be true for note deletion or restoration.');
}

type VersionedWriteInput = { expectedVersion: number; deviceId: string; mutationId: string };

export async function deleteNoteTool(client: WriteQNotesClient, args: { noteId: string; expectedVersion: number; confirm: true; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  requireConfirmation(args.confirm);
  const mutationId = args.mutationId ?? crypto.randomUUID();
  const input: VersionedWriteInput = { expectedVersion: args.expectedVersion, deviceId: deviceId(args, options), mutationId };
  const result = client.deleteNoteDetailed
    ? await client.deleteNoteDetailed(args.noteId, input)
    : { note: await client.deleteNote(args.noteId, input), outcome: 'applied' as const };
  return toolResult(acknowledgment(result.note, mutationId, result.outcome));
}

export async function restoreNoteTool(client: WriteQNotesClient, args: { noteId: string; expectedVersion: number; confirm: true; deviceId?: string; mutationId?: string }, options?: WriteToolOptions) {
  requireConfirmation(args.confirm);
  const mutationId = args.mutationId ?? crypto.randomUUID();
  const input: VersionedWriteInput = { expectedVersion: args.expectedVersion, deviceId: deviceId(args, options), mutationId };
  const result = client.restoreNoteDetailed
    ? await client.restoreNoteDetailed(args.noteId, input)
    : { note: await client.restoreNote(args.noteId, input), outcome: 'applied' as const };
  return toolResult(acknowledgment(result.note, mutationId, result.outcome));
}
