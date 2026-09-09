import { IndexedDbDraftStore } from '@qnotes/sync';
import type { Note, NoteSummary } from '@qnotes/shared';
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
  await getAccountDraftStore(userId).putNoteSnapshot(note);
}

export async function readRememberedNote(noteId: string, userId: string): Promise<Note | null> {
  return getAccountDraftStore(userId).getNoteSnapshot(noteId);
}

export async function searchRecentNotes(query: string, userId: string): Promise<NoteSummary[]> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const notes = await getAccountDraftStore(userId).listRecent();
  return notes.filter((note) => note.title.toLocaleLowerCase().includes(normalized) || note.tags.some((tag) => tag.toLocaleLowerCase().includes(normalized)));
}

export async function rememberSearchSelection(selection: SearchSelection, userId: string): Promise<void> {
  await getAccountDraftStore(userId).putSearchSelection(selection);
}

export async function removeRememberedNote(noteId: string, userId: string): Promise<void> {
  await getAccountDraftStore(userId).deleteRecent(noteId);
}

export async function readSyncCursor(userId: string): Promise<string | null> {
  return getAccountDraftStore(userId).getCursor();
}

export async function writeSyncCursor(cursor: string | null, userId: string): Promise<void> {
  await getAccountDraftStore(userId).setCursor(cursor);
}
