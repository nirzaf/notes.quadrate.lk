import type { Note, UUID } from '@qnotes/shared';
import { threeWayMerge, type MergeConflict } from './diff3.js';
import type { NoteDraft } from './drafts.js';

export interface DraftValues {
  markdown: string;
  title: string;
  tags: string[];
  notebookId: UUID | null;
}

export type DraftReconciliationReason = 'invalid-base' | 'newer-base' | 'base-mismatch' | 'remote-deleted' | 'body' | 'title' | 'tags' | 'notebook';

export type DraftReconciliation =
  | { status: 'clean'; values: DraftValues; conflicts: [] }
  | { status: 'conflict'; values: DraftValues; conflicts: MergeConflict[]; reason: DraftReconciliationReason };

function equalArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeScalar<T>(base: T, local: T, remote: T): { value: T; conflict: boolean } {
  if (Object.is(local, remote)) return { value: local, conflict: false };
  if (Object.is(local, base)) return { value: remote, conflict: false };
  if (Object.is(remote, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function mergeTags(base: string[], local: string[], remote: string[]): { value: string[]; conflict: boolean } {
  const normalizedBase = unique(base);
  const normalizedLocal = unique(local);
  const normalizedRemote = unique(remote);
  if (equalArray(normalizedLocal, normalizedRemote)) return { value: normalizedLocal, conflict: false };
  if (equalArray(normalizedLocal, normalizedBase)) return { value: normalizedRemote, conflict: false };
  if (equalArray(normalizedRemote, normalizedBase)) return { value: normalizedLocal, conflict: false };

  // Tags merge only when both sides preserve the original order and add values.
  // Deletions or reordering remain conflicts so a recovery cannot hide intent.
  const localBaseOrder = normalizedBase.filter((tag) => normalizedLocal.includes(tag));
  const remoteBaseOrder = normalizedBase.filter((tag) => normalizedRemote.includes(tag));
  if (!equalArray(localBaseOrder, normalizedBase)
    || !equalArray(remoteBaseOrder, normalizedBase)
    || !equalArray(normalizedLocal.slice(0, normalizedBase.length), normalizedBase)
    || !equalArray(normalizedRemote.slice(0, normalizedBase.length), normalizedBase)) {
    return { value: normalizedLocal, conflict: true };
  }
  const additions = [...normalizedLocal, ...normalizedRemote].filter((tag) => !normalizedBase.includes(tag));
  return { value: unique([...normalizedBase, ...additions]), conflict: false };
}

function draftValues(draft: NoteDraft, remote: Note): DraftValues {
  return {
    markdown: typeof draft.localMarkdown === 'string' ? draft.localMarkdown : '',
    title: draft.localTitle === undefined ? remote.title : draft.localTitle,
    tags: draft.localTags === undefined ? [...remote.tags] : [...draft.localTags],
    notebookId: draft.localNotebookId === undefined ? remote.notebookId : draft.localNotebookId,
  };
}

function baseMatchesRemote(draft: NoteDraft, remote: Note): boolean {
  return draft.baseMarkdown === remote.contentMarkdown
    && (draft.baseTitle === undefined || draft.baseTitle === remote.title)
    && (draft.baseTags === undefined || equalArray(draft.baseTags, remote.tags))
    && (draft.baseNotebookId === undefined || draft.baseNotebookId === remote.notebookId);
}

export function reconcileDraft(draft: NoteDraft, remote: Note): DraftReconciliation {
  const local = draftValues(draft, remote);
  if (!Number.isSafeInteger(draft.baseVersion) || typeof draft.baseMarkdown !== 'string' || typeof draft.localMarkdown !== 'string') {
    return { status: 'conflict', values: local, conflicts: [], reason: 'invalid-base' };
  }
  if (remote.deletedAt) return { status: 'conflict', values: local, conflicts: [], reason: 'remote-deleted' };
  if (draft.baseVersion > remote.version) return { status: 'conflict', values: local, conflicts: [], reason: 'newer-base' };
  if (draft.baseVersion === remote.version) {
    if (!baseMatchesRemote(draft, remote)) return { status: 'conflict', values: local, conflicts: [], reason: 'base-mismatch' };
    return { status: 'clean', values: local, conflicts: [] };
  }

  const body = threeWayMerge(draft.baseMarkdown, draft.localMarkdown, remote.contentMarkdown);
  const title = draft.baseTitle !== undefined && draft.localTitle !== undefined
    ? mergeScalar(draft.baseTitle, draft.localTitle, remote.title)
    : { value: remote.title, conflict: false };
  const tags = draft.baseTags !== undefined && draft.localTags !== undefined
    ? mergeTags(draft.baseTags, draft.localTags, remote.tags)
    : { value: [...remote.tags], conflict: false };
  const notebook = draft.baseNotebookId !== undefined && draft.localNotebookId !== undefined
    ? mergeScalar(draft.baseNotebookId, draft.localNotebookId, remote.notebookId)
    : { value: remote.notebookId, conflict: false };
  const reason = body.status === 'conflict' ? 'body' : title.conflict ? 'title' : tags.conflict ? 'tags' : notebook.conflict ? 'notebook' : null;
  if (reason) {
    return {
      status: 'conflict',
      values: { ...local, markdown: body.status === 'clean' ? body.merged : local.markdown, title: title.conflict ? local.title : title.value, tags: tags.conflict ? local.tags : tags.value, notebookId: notebook.conflict ? local.notebookId : notebook.value },
      conflicts: body.conflicts,
      reason,
    };
  }
  return { status: 'clean', values: { markdown: body.merged, title: title.value, tags: tags.value, notebookId: notebook.value }, conflicts: [] };
}
