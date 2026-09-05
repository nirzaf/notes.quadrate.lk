import type { ISODateTime, NoteSummary, UUID } from '@qnotes/shared';

export interface NoteDraft {
  noteId: UUID;
  baseVersion: number;
  baseMarkdown: string;
  localMarkdown: string;
  /** Optional so drafts written before metadata recovery was added remain readable. */
  baseTitle?: string;
  localTitle?: string;
  baseTags?: string[];
  localTags?: string[];
  baseNotebookId?: UUID | null;
  localNotebookId?: UUID | null;
  updatedAt: ISODateTime;
}

export interface SearchSelection {
  queryId: UUID;
  documentId: UUID;
  selectedAt: ISODateTime;
}

export interface DraftStore {
  get(noteId: UUID): Promise<NoteDraft | null>;
  put(draft: NoteDraft): Promise<void>;
  delete(noteId: UUID): Promise<void>;
  listRecent(limit?: number): Promise<NoteSummary[]>;
  putSearchSelection(selection: SearchSelection): Promise<void>;
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
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', { keyPath: 'noteId' });
        if (!database.objectStoreNames.contains('sync')) database.createObjectStore('sync', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('recentNotes')) database.createObjectStore('recentNotes', { keyPath: 'noteId' });
        if (!database.objectStoreNames.contains('searchSelections')) database.createObjectStore('searchSelections', { autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open qnotes IndexedDB.'));
    });
    return this.database;
  }

  private async write(storeName: string, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    const database = await this.open();
    if (!database) throw new Error('Local storage is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      try {
        operation(transaction.objectStore(storeName));
      } catch (error: unknown) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
    });
  }

  async get(noteId: UUID): Promise<NoteDraft | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readonly');
      const request = transaction.objectStore('drafts').get(noteId);
      let value: NoteDraft | null = null;
      request.onsuccess = () => { value = (request.result as NoteDraft | undefined) ?? null; };
      request.onerror = () => reject(request.error ?? new Error('Unable to read note draft.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read note draft.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to read note draft.'));
    });
  }

  async put(draft: NoteDraft): Promise<void> {
    await this.write('drafts', (store) => store.put(draft));
  }

  async delete(noteId: UUID): Promise<void> {
    await this.write('drafts', (store) => store.delete(noteId));
  }

  async getCursor(): Promise<string | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('sync', 'readonly');
      const request = transaction.objectStore('sync').get('notesCursor');
      let value: string | null = null;
      request.onsuccess = () => { value = (request.result as SyncRecord | undefined)?.value || null; };
      request.onerror = () => reject(request.error ?? new Error('Unable to read sync cursor.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read sync cursor.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to read sync cursor.'));
    });
  }

  async setCursor(value: string | null): Promise<void> {
    await this.write('sync', (store) => store.put({ key: 'notesCursor', value: value ?? '' }));
  }

  async putRecent(note: { id: UUID } & Record<string, unknown>): Promise<void> {
    await this.write('recentNotes', (store) => store.put({ ...note, noteId: note.id }));
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    await this.write('recentNotes', (store) => store.delete(noteId));
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    const database = await this.open();
    if (!database) return [];
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recentNotes', 'readonly');
      const request = transaction.objectStore('recentNotes').getAll();
      let value: NoteSummary[] = [];
      request.onsuccess = () => { value = (request.result as NoteSummary[]).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, limit); };
      request.onerror = () => reject(request.error ?? new Error('Unable to list cached notes.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
    });
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    await this.write('searchSelections', (store) => store.add(selection));
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<UUID, NoteDraft>();
  private readonly recent = new Map<UUID, NoteSummary>();
  private readonly selections: SearchSelection[] = [];

  async get(noteId: UUID): Promise<NoteDraft | null> {
    return this.drafts.get(noteId) ?? null;
  }

  async put(draft: NoteDraft): Promise<void> {
    this.drafts.set(draft.noteId, draft);
  }

  async delete(noteId: UUID): Promise<void> {
    this.drafts.delete(noteId);
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    return [...this.recent.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, limit);
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    this.selections.push(selection);
  }
}
