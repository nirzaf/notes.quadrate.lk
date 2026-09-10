import type { PatchNoteSectionInput, QNotesCapabilities, QNotesCapabilityProfile } from '@qnotes/shared';
import { DEFAULT_SYNC_LIMIT } from '@qnotes/shared';
import { capabilitiesSchema, mutationAcknowledgmentSchema, mutationStatusSchema, noteOutlineSchema, noteSectionPatchPreviewSchema, syncPageSchema } from '../contracts.ts';
import { toolResult, type ReadQNotesClient } from './common.ts';
import type { WriteQNotesClient, WriteToolOptions } from './write-notes.ts';

const MCP_DEVICE_ID = crypto.randomUUID();

function deviceId(args: { deviceId?: string }, options?: WriteToolOptions): string {
  return args.deviceId ?? options?.deviceId ?? MCP_DEVICE_ID;
}

function acknowledgment(note: { id: string; title: string; version: number }, mutationId: string, outcome: 'applied' | 'idempotent') {
  return { noteId: note.id, title: note.title, resultingVersion: note.version, mutationId, outcome, uri: `qnotes://notes/${note.id}` };
}

export async function getCapabilitiesTool(client: ReadQNotesClient, profile: QNotesCapabilityProfile, supportedOperations: readonly string[]) {
  const capabilities = await client.getCapabilities();
  const result: QNotesCapabilities = { ...capabilities, effectiveProfile: profile, supportedOperations: [...supportedOperations] };
  return toolResult(result, capabilitiesSchema);
}

export async function getNoteOutlineTool(client: ReadQNotesClient, args: { noteRef: string }) {
  return toolResult(await client.getNoteOutline(args.noteRef), noteOutlineSchema);
}

export async function getMutationStatusTool(client: ReadQNotesClient, args: { mutationId: string }) {
  return toolResult(await client.getMutationStatus(args.mutationId), mutationStatusSchema);
}

export async function listNoteChangesTool(client: ReadQNotesClient, args: { cursor?: string; limit?: number }) {
  return toolResult(await client.sync(args.cursor, args.limit ?? DEFAULT_SYNC_LIMIT), syncPageSchema);
}

export async function patchNoteSectionTool(client: WriteQNotesClient, args: Omit<PatchNoteSectionInput, 'deviceId'> & { noteId: string; deviceId?: string }, options?: WriteToolOptions) {
  const mutationId = args.mutationId;
  const result = await client.patchNoteSection(args.noteId, {
    sectionId: args.sectionId,
    expectedVersion: args.expectedVersion,
    expectedContentHash: args.expectedContentHash,
    replacementMarkdown: args.replacementMarkdown,
    deviceId: deviceId(args, options),
    mutationId,
  });
  return toolResult(acknowledgment(result.note, mutationId, result.outcome), mutationAcknowledgmentSchema);
}

export async function previewNoteSectionTool(client: WriteQNotesClient, args: Omit<PatchNoteSectionInput, 'deviceId'> & { noteId: string; deviceId?: string }, options?: WriteToolOptions) {
  return toolResult(await client.previewNoteSection(args.noteId, {
    sectionId: args.sectionId,
    expectedVersion: args.expectedVersion,
    expectedContentHash: args.expectedContentHash,
    replacementMarkdown: args.replacementMarkdown,
    deviceId: deviceId(args, options),
    mutationId: args.mutationId,
  }), noteSectionPatchPreviewSchema);
}
