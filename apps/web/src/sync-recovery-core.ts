import { noteQueryKeys, refreshNoteCollections, refreshNoteViewsForNotes } from './note-query-keys.ts';

export interface SyncRecoveryChange {
  noteId: string;
  deletedAt: string | null;
}

export interface SyncRecoveryPage {
  changes: SyncRecoveryChange[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SyncRecoveryApi {
  sync: (cursor?: string, limit?: number, options?: { signal?: AbortSignal }) => Promise<SyncRecoveryPage>;
}

interface SyncRecoveryQueryClient {
  invalidateQueries: (filters: { queryKey: readonly unknown[] } | { predicate: (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => boolean }) => Promise<unknown>;
}

interface SyncRecoveryOptions {
  userId: string;
  queryClient: SyncRecoveryQueryClient;
  api: SyncRecoveryApi;
  readSyncCursor: (userId: string) => Promise<string | null>;
  writeSyncCursor: (cursor: string | null, userId: string) => Promise<void>;
  removeRememberedNote: (noteId: string, userId: string) => Promise<void>;
  clearRememberedNotes?: (userId: string) => Promise<void>;
  generation: number;
  getGeneration: () => number;
  signal: AbortSignal;
}

export async function runSyncRecovery({ userId, queryClient, api, readSyncCursor, writeSyncCursor, removeRememberedNote, clearRememberedNotes, generation, getGeneration, signal }: SyncRecoveryOptions): Promise<void> {
  const isStale = () => signal.aborted || generation !== getGeneration();
  if (isStale()) return;

  let cursor = await readSyncCursor(userId);
  let initialCursor = cursor;
  let reset = false;
  const changedNoteIds = new Set<string>();
  const deletedNoteIds = new Set<string>();
  let hasMore = true;

  while (hasMore) {
    if (isStale()) return;
    let page: SyncRecoveryPage;
    try {
      page = await api.sync(cursor ?? undefined, undefined, { signal });
    } catch (error: unknown) {
      if (cursor === null || !isInvalidCursorError(error)) throw error;
      cursor = null;
      initialCursor = null;
      reset = true;
      changedNoteIds.clear();
      deletedNoteIds.clear();
      await writeSyncCursor(null, userId);
      await clearRememberedNotes?.(userId);
      continue;
    }
    if (isStale()) return;
    for (const change of page.changes) {
      changedNoteIds.add(change.noteId);
      if (change.deletedAt) deletedNoteIds.add(change.noteId);
      else deletedNoteIds.delete(change.noteId);
    }
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }

  for (const noteId of deletedNoteIds) {
    if (isStale()) return;
    await removeRememberedNote(noteId, userId);
  }
  if (isStale()) return;
  await writeSyncCursor(cursor, userId);

  if (changedNoteIds.size > 0) {
    await refreshNoteViewsForNotes(queryClient, userId, changedNoteIds);
  } else if (initialCursor === null) {
    await refreshNoteCollections(queryClient, userId);
  }
  if (reset) await queryClient.invalidateQueries({ queryKey: noteQueryKeys.forUser(userId).all });
}

function isInvalidCursorError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  return value.status === 422 && value.code === 'VALIDATION_ERROR' && value.message === 'cursor is invalid or expired.';
}
