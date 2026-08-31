import { IndexedDbDraftStore } from '@qnotes/sync';
import type { Note } from '@qnotes/shared';

export const draftStore = new IndexedDbDraftStore('qnotes');

export function getDeviceId(): string {
  const key = 'qnotes.deviceId';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem(key, value);
  return value;
}

export async function rememberNote(note: Note): Promise<void> {
  await draftStore.putRecent({ ...note, noteId: note.id });
}

export async function removeRememberedNote(noteId: string): Promise<void> {
  await draftStore.deleteRecent(noteId);
}

export async function readSyncCursor(): Promise<string | null> {
  return draftStore.getCursor();
}

export async function writeSyncCursor(cursor: string | null): Promise<void> {
  await draftStore.setCursor(cursor);
}
