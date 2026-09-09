import { refreshNoteCollections, refreshNoteViewsForNotes } from './note-query-keys.ts';

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
  generation: number;
  getGeneration: () => number;
  signal: AbortSignal;
}

export async function runSyncRecovery({ userId, queryClient, api, readSyncCursor, writeSyncCursor, removeRememberedNote, generation, getGeneration, signal }: SyncRecoveryOptions): Promise<void> {
  const isStale = () => signal.aborted || generation !== getGeneration();
  if (isStale()) return;

  let cursor = await readSyncCursor(userId);
  const initialCursor = cursor;
  const changedNoteIds = new Set<string>();
  const deletedNoteIds = new Set<string>();
  let hasMore = true;

  while (hasMore) {
    if (isStale()) return;
    const page = await api.sync(cursor ?? undefined, undefined, { signal });
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
}
