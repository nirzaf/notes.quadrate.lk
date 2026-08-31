import type { ISODateTime, UUID } from '@qnotes/shared';

export interface NoteDraft {
  noteId: UUID;
  baseVersion: number;
  baseMarkdown: string;
  localMarkdown: string;
  updatedAt: ISODateTime;
}

export interface DraftStore {
  get(noteId: UUID): Promise<NoteDraft | null>;
  put(draft: NoteDraft): Promise<void>;
  delete(noteId: UUID): Promise<void>;
}

type SyncRecord = { key: string; value: string };

export class IndexedDbDraftStore implements DraftStore {
  private readonly databaseName: string;
  private database: IDBDatabase | null = null;

  constructor(databaseName = 'qnotes') {
    this.databaseName = databaseName;
  }

  private async open(): Promise<IDBDatabase | null> {
    if (this.database) return this.database;
    if (typeof indexedDB === 'undefined') return null;
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', { keyPath: 'noteId' });
        if (!database.objectStoreNames.contains('sync')) database.createObjectStore('sync', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('recentNotes')) database.createObjectStore('recentNotes', { keyPath: 'noteId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open qnotes IndexedDB.'));
    });
    return this.database;
  }

  async get(noteId: UUID): Promise<NoteDraft | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction('drafts', 'readonly').objectStore('drafts').get(noteId);
      request.onsuccess = () => resolve((request.result as NoteDraft | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Unable to read note draft.'));
    });
  }

  async put(draft: NoteDraft): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction('drafts', 'readwrite').objectStore('drafts').put(draft);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Unable to save note draft.'));
    });
  }

  async delete(noteId: UUID): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction('drafts', 'readwrite').objectStore('drafts').delete(noteId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Unable to delete note draft.'));
    });
  }

  async getCursor(): Promise<string | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction('sync', 'readonly').objectStore('sync').get('notesCursor');
      request.onsuccess = () => resolve((request.result as SyncRecord | undefined)?.value || null);
      request.onerror = () => reject(request.error ?? new Error('Unable to read sync cursor.'));
    });
  }

  async setCursor(value: string | null): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction('sync', 'readwrite').objectStore('sync').put({ key: 'notesCursor', value: value ?? '' });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Unable to write sync cursor.'));
    });
  }

  async putRecent(note: { id: UUID } & Record<string, unknown>): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction('recentNotes', 'readwrite').objectStore('recentNotes').put(note);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Unable to cache recent note.'));
    });
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction('recentNotes', 'readwrite').objectStore('recentNotes').delete(noteId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Unable to remove cached note.'));
    });
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<UUID, NoteDraft>();

  async get(noteId: UUID): Promise<NoteDraft | null> {
    return this.drafts.get(noteId) ?? null;
  }

  async put(draft: NoteDraft): Promise<void> {
    this.drafts.set(draft.noteId, draft);
  }

  async delete(noteId: UUID): Promise<void> {
    this.drafts.delete(noteId);
  }
}
