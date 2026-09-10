import type { ISODateTime, Note, NoteSummary, UUID } from '@qnotes/shared';

export interface NoteDraft {
  noteId: UUID;
  baseVersion: number;
  baseMarkdown: string;
  localMarkdown: string;
  /** Stable retry identity persisted before an autosave request is sent. */
  mutationId?: UUID;
  /** Stable retry identity for a recovered notebook move sent separately. */
  notebookMutationId?: UUID;
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
  clearRecent(): Promise<void>;
  listRecent(limit?: number): Promise<NoteSummary[]>;
  putSearchSelection(selection: SearchSelection): Promise<void>;
}

type SyncRecord = { key: string; value: string };

type SearchRecord = NoteSummary & {
  contentMarkdown: string;
  contentPlain: string;
};

export interface CachedSyncPage {
  notes: Note[];
  deletedNoteIds: UUID[];
  cursor: string | null;
  reset?: boolean;
}

export const MAX_CACHED_NOTES = 2_000;

function noteSummary(note: Note): NoteSummary {
  return {
    id: note.id,
    slug: note.slug,
    title: note.title,
    excerpt: note.contentPlain.slice(0, 280),
    tags: [...note.tags],
    notebookId: note.notebookId,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
  };
}

function searchRecord(note: Note): SearchRecord {
  return { ...noteSummary(note), contentMarkdown: note.contentMarkdown, contentPlain: note.contentPlain };
}

function fromSearchRecord(record: SearchRecord): NoteSummary {
  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    excerpt: record.excerpt,
    tags: [...record.tags],
    notebookId: record.notebookId,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
  };
}

function matchesSearch(record: SearchRecord, query: string): boolean {
  const haystack = [record.title, record.tags.join(' '), record.contentPlain, record.contentMarkdown].join('\n').toLocaleLowerCase();
  return haystack.includes(query);
}

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
      const request = indexedDB.open(this.databaseName, 3);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', { keyPath: 'noteId' });
        if (!database.objectStoreNames.contains('sync')) database.createObjectStore('sync', { keyPath: 'key' });
        const recentNotes = database.objectStoreNames.contains('recentNotes')
          ? request.transaction!.objectStore('recentNotes')
          : database.createObjectStore('recentNotes', { keyPath: 'noteId' });
        if (!recentNotes.indexNames.contains('updatedAt')) recentNotes.createIndex('updatedAt', 'updatedAt');
        if (!database.objectStoreNames.contains('searchSelections')) database.createObjectStore('searchSelections', { autoIncrement: true });
        const searchRecords = database.objectStoreNames.contains('searchRecords')
          ? request.transaction!.objectStore('searchRecords')
          : database.createObjectStore('searchRecords', { keyPath: 'id' });
        if (!searchRecords.indexNames.contains('updatedAt')) searchRecords.createIndex('updatedAt', 'updatedAt');
        if (event.oldVersion < 3) {
          const records = searchRecords;
          const cursorRequest = recentNotes.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value as Partial<Note> & NoteSummary;
            if (typeof value.contentMarkdown === 'string' && typeof value.contentPlain === 'string') {
              records.put(searchRecord(value as Note));
              cursor.update({ ...noteSummary(value as Note), noteId: value.id });
            }
            cursor.continue();
          };
        }
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

  private async pruneCachedNotes(transaction: IDBTransaction): Promise<void> {
    const index = transaction.objectStore('recentNotes').index('updatedAt');
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        seen += 1;
        if (seen > MAX_CACHED_NOTES) {
          const noteId = cursor.primaryKey;
          transaction.objectStore('recentNotes').delete(noteId);
          transaction.objectStore('searchRecords').delete(noteId);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to prune cached notes.'));
    });
  }

  async putRecent(note: Note): Promise<void> {
    const database = await this.open();
    if (!database) throw new Error('Local storage is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['recentNotes', 'searchRecords'], 'readwrite');
      transaction.objectStore('recentNotes').put({ ...noteSummary(note), noteId: note.id });
      transaction.objectStore('searchRecords').put(searchRecord(note));
      void this.pruneCachedNotes(transaction).catch(reject);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to cache note.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
    });
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['recentNotes', 'searchRecords'], 'readwrite');
      transaction.objectStore('recentNotes').delete(noteId);
      transaction.objectStore('searchRecords').delete(noteId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to delete cached note.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
    });
  }

  async clearRecent(): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['recentNotes', 'searchRecords'], 'readwrite');
      transaction.objectStore('recentNotes').clear();
      transaction.objectStore('searchRecords').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to clear cached notes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
    });
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    const database = await this.open();
    if (!database) return [];
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recentNotes', 'readonly');
      const request = transaction.objectStore('recentNotes').index('updatedAt').openCursor(null, 'prev');
      let value: NoteSummary[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || value.length >= limit) return;
        value.push(cursor.value as NoteSummary);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to list cached notes.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
    });
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    await this.write('searchSelections', (store) => store.add(selection));
  }

  async searchRecent(query: string, limit = 50): Promise<NoteSummary[]> {
    const database = await this.open();
    if (!database) return [];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('searchRecords', 'readonly');
      const request = transaction.objectStore('searchRecords').index('updatedAt').openCursor(null, 'prev');
      const value: NoteSummary[] = [];
      let scanned = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || value.length >= limit || scanned >= MAX_CACHED_NOTES) return;
        scanned += 1;
        const record = cursor.value as SearchRecord;
        if (!record.deletedAt && matchesSearch(record, normalized)) value.push(fromSearchRecord(record));
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to search cached notes.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to search cached notes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to search cached notes.'));
    });
  }

  async applySyncPage({ notes, deletedNoteIds, cursor, reset = false }: CachedSyncPage): Promise<void> {
    const database = await this.open();
    if (!database) throw new Error('Local storage is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['recentNotes', 'searchRecords', 'sync'], 'readwrite');
      const recent = transaction.objectStore('recentNotes');
      const searchable = transaction.objectStore('searchRecords');
      if (reset) {
        recent.clear();
        searchable.clear();
      }
      for (const note of notes) {
        recent.put({ ...noteSummary(note), noteId: note.id });
        searchable.put(searchRecord(note));
      }
      for (const noteId of deletedNoteIds) {
        recent.delete(noteId);
        searchable.delete(noteId);
      }
      transaction.objectStore('sync').put({ key: 'notesCursor', value: cursor ?? '' });
      void this.pruneCachedNotes(transaction).catch(reject);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to apply sync page.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local sync transaction was aborted.'));
    });
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<UUID, NoteDraft>();
  private readonly recent = new Map<UUID, NoteSummary>();
  private readonly searchable = new Map<UUID, SearchRecord>();
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

  async putRecent(note: Note): Promise<void> {
    this.recent.set(note.id, noteSummary(note));
    this.searchable.set(note.id, searchRecord(note));
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    this.recent.delete(noteId);
    this.searchable.delete(noteId);
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    return [...this.recent.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, limit);
  }

  async clearRecent(): Promise<void> {
    this.recent.clear();
    this.searchable.clear();
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    this.selections.push(selection);
  }

  async searchRecent(query: string, limit = 50): Promise<NoteSummary[]> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return [...this.searchable.values()]
      .filter((record) => !record.deletedAt && matchesSearch(record, normalized))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map(fromSearchRecord);
  }

  async applySyncPage({ notes, deletedNoteIds, cursor: _cursor, reset = false }: CachedSyncPage): Promise<void> {
    if (reset) this.clearRecent();
    for (const note of notes) await this.putRecent(note);
    for (const noteId of deletedNoteIds) await this.deleteRecent(noteId);
  }
}
