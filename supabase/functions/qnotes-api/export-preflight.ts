export const MAX_EXPORT_ENTRIES = 5_000;

export interface WorkspaceExportPlan {
  noteMarkdownBytes: number;
  attachmentBytes: number;
  manifestBytes: number;
  entryCount: number;
  estimatedBytes: number;
}

export type WorkspaceExportPlanFailure = 'invalid_metadata' | 'too_many_entries' | 'too_large';

export type WorkspaceExportPlanResult =
  | { ok: true; plan: WorkspaceExportPlan }
  | { ok: false; reason: WorkspaceExportPlanFailure; plan: WorkspaceExportPlan };

export function planWorkspaceExport(
  noteMarkdownBytes: number,
  attachmentBytes: number,
  manifestBytes: number,
  entryCount: number,
  maxBytes: number,
): WorkspaceExportPlanResult {
  const plan = {
    noteMarkdownBytes,
    attachmentBytes,
    manifestBytes,
    entryCount,
    estimatedBytes: noteMarkdownBytes + attachmentBytes + manifestBytes + (entryCount * 256),
  } satisfies WorkspaceExportPlan;
  if (![noteMarkdownBytes, attachmentBytes, manifestBytes, entryCount, maxBytes].every(Number.isSafeInteger) || [noteMarkdownBytes, attachmentBytes, manifestBytes, entryCount].some((value) => value < 0) || maxBytes <= 0) {
    return { ok: false, reason: 'invalid_metadata', plan };
  }
  if (entryCount > MAX_EXPORT_ENTRIES) return { ok: false, reason: 'too_many_entries', plan };
  if (plan.estimatedBytes > maxBytes) return { ok: false, reason: 'too_large', plan };
  return { ok: true, plan };
}
