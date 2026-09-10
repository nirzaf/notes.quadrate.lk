import { noteQueryKeys, refreshNoteCollections, refreshNoteViewsForNotes } from './note-query-keys.ts';
import type { Note } from '@qnotes/shared';

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
  getNote?: (noteId: string, options?: { includeDeleted?: boolean; signal?: AbortSignal }) => Promise<Note>;
}

interface SyncRecoveryApplyPage {
  notes: Note[];
  deletedNoteIds: string[];
  cursor: string | null;
  reset?: boolean;
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
  applySyncPage?: (page: SyncRecoveryApplyPage, userId: string) => Promise<void>;
  generation: number;
  getGeneration: () => number;
  signal: AbortSignal;
}

const SYNC_NOTE_FETCH_CONCURRENCY = 8;

async function fetchChangedNotes(api: SyncRecoveryApi, changes: SyncRecoveryChange[], signal: AbortSignal): Promise<Note[]> {
  if (!api.getNote) return [];
  const notes: Note[] = [];
  for (let offset = 0; offset < changes.length; offset += SYNC_NOTE_FETCH_CONCURRENCY) {
    const batch = changes.slice(offset, offset + SYNC_NOTE_FETCH_CONCURRENCY);
    notes.push(...await Promise.all(batch.map((change) => api.getNote!(change.noteId, { includeDeleted: true, signal }))));
  }
  return notes;
}

export async function runSyncRecovery({ userId, queryClient, api, readSyncCursor, writeSyncCursor, removeRememberedNote, clearRememberedNotes, applySyncPage, generation, getGeneration, signal }: SyncRecoveryOptions): Promise<void> {
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
      if (applySyncPage) await applySyncPage({ notes: [], deletedNoteIds: [], cursor: null, reset: true }, userId);
      else {
        await writeSyncCursor(null, userId);
        await clearRememberedNotes?.(userId);
      }
      continue;
    }
    if (isStale()) return;
    for (const change of page.changes) {
      changedNoteIds.add(change.noteId);
      if (change.deletedAt) deletedNoteIds.add(change.noteId);
      else deletedNoteIds.delete(change.noteId);
    }
    if (applySyncPage) {
      const currentDeleted = page.changes.filter((change) => Boolean(change.deletedAt)).map((change) => change.noteId);
      const fetchedNotes = await fetchChangedNotes(api, page.changes.filter((change) => !change.deletedAt), signal);
      const notes = fetchedNotes.filter((note) => !note.deletedAt);
      const fetchedDeleted = fetchedNotes.filter((note) => Boolean(note.deletedAt)).map((note) => note.id);
      if (isStale()) return;
      await applySyncPage({ notes, deletedNoteIds: [...new Set([...currentDeleted, ...fetchedDeleted])], cursor: page.nextCursor }, userId);
    }
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }

  if (!applySyncPage) {
    for (const noteId of deletedNoteIds) {
      if (isStale()) return;
      await removeRememberedNote(noteId, userId);
    }
    if (isStale()) return;
    await writeSyncCursor(cursor, userId);
  }

  if (changedNoteIds.size > 0) {
    await refreshNoteViewsForNotes(queryClient, userId, changedNoteIds);
  } else if (initialCursor === null) {
    await refreshNoteCollections(queryClient, userId);
  }
  if (reset) await queryClient.invalidateQueries({ queryKey: noteQueryKeys.forUser(userId).root });
}

function isInvalidCursorError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  return value.status === 422 && value.code === 'VALIDATION_ERROR' && value.message === 'cursor is invalid or expired.';
}
