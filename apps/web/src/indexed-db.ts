import { IndexedDbDraftStore } from '@qnotes/sync';
import type { Note, NoteSummary, UUID } from '@qnotes/shared';
import type { SearchSelection } from '@qnotes/sync';

const stores = new Map<string, IndexedDbDraftStore>();

/** Account data lives in an account-specific database; the legacy qnotes DB is left untouched. */
export function getAccountDraftStore(userId: string): IndexedDbDraftStore {
  let store = stores.get(userId);
  if (!store) {
    store = new IndexedDbDraftStore(`qnotes-account-${encodeURIComponent(userId)}`);
    stores.set(userId, store);
  }
  return store;
}

export function getDeviceId(): string {
  const key = 'qnotes.deviceId';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem(key, value);
  return value;
}

export async function rememberNote(note: Note, userId: string): Promise<void> {
  await getAccountDraftStore(userId).putRecent(note);
}

export async function searchRecentNotes(query: string, userId: string): Promise<NoteSummary[]> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return getAccountDraftStore(userId).searchRecent(normalized);
}

export async function rememberSearchSelection(selection: SearchSelection, userId: string): Promise<void> {
  await getAccountDraftStore(userId).putSearchSelection(selection);
}

export async function removeRememberedNote(noteId: string, userId: string): Promise<void> {
  await getAccountDraftStore(userId).deleteRecent(noteId);
}

export async function clearRememberedNotes(userId: string): Promise<void> {
  await getAccountDraftStore(userId).clearRecent();
}

export async function readSyncCursor(userId: string): Promise<string | null> {
  return getAccountDraftStore(userId).getCursor();
}

export async function writeSyncCursor(cursor: string | null, userId: string): Promise<void> {
  await getAccountDraftStore(userId).setCursor(cursor);
}

export async function applySyncPage(page: { notes: Note[]; deletedNoteIds: UUID[]; cursor: string | null; reset?: boolean }, userId: string): Promise<void> {
  await getAccountDraftStore(userId).applySyncPage(page);
}
