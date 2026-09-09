import type { ISODateTime, Note, NoteSummary, UUID } from '@qnotes/shared';

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
type RecentRecord = { id: UUID; noteId?: UUID; [key: string]: unknown };

const MAX_SNAPSHOT_COUNT = 50;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isCompleteNoteSnapshot(value: unknown): value is Note {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.slug)
    && isString(value.title)
    && isString(value.contentMarkdown)
    && isString(value.contentPlain)
    && isStringArray(value.tags)
    && isNullableString(value.notebookId)
    && typeof value.version === 'number'
    && Number.isSafeInteger(value.version)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && isNullableString(value.deletedAt);
}

function snapshotRecord(value: unknown): value is RecentRecord & Note {
  return isCompleteNoteSnapshot(value)
    && isString((value as unknown as RecentRecord).noteId)
    && value.id === (value as unknown as RecentRecord).noteId;
}

function noteFromSnapshotRecord(value: RecentRecord & Note): Note {
  const { noteId: _noteId, ...note } = value;
  return note;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function snapshotIdsToDelete(records: unknown[]): string[] {
  const snapshots = records.filter((record): record is RecentRecord & Note => snapshotRecord(record) && !record.deletedAt);
  snapshots.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const keep = new Set<string>();
  let totalBytes = 0;
  for (const snapshot of snapshots) {
    const bytes = serializedBytes(snapshot);
    if (keep.size >= MAX_SNAPSHOT_COUNT || totalBytes + bytes > MAX_SNAPSHOT_BYTES) continue;
    keep.add(snapshot.id);
    totalBytes += bytes;
  }
  return snapshots.filter((snapshot) => !keep.has(snapshot.id)).map((snapshot) => snapshot.id);
}

export class IndexedDbDraftStore implements DraftStore {
  private readonly databaseName: string;
  private database: IDBDatabase | null = null;
  private snapshotMutationChain: Promise<void> = Promise.resolve();

  private enqueueSnapshotMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.snapshotMutationChain.then(operation);
    this.snapshotMutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

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

  private async readRecentRecords(): Promise<unknown[]> {
    const database = await this.open();
    if (!database) return [];
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recentNotes', 'readonly');
      const request = transaction.objectStore('recentNotes').getAll();
      let value: unknown[] = [];
      request.onsuccess = () => { value = Array.isArray(request.result) ? request.result : []; };
      request.onerror = () => reject(request.error ?? new Error('Unable to list cached notes.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to list cached notes.'));
    });
  }

  private async pruneSnapshots(): Promise<void> {
    const records = await this.readRecentRecords();
    const ids = snapshotIdsToDelete(records);
    if (ids.length === 0) return;
    await this.write('recentNotes', (store) => {
      let request: IDBRequest | null = null;
      for (const id of ids) request = store.delete(id);
      if (!request) throw new Error('No snapshot records selected for deletion.');
      return request;
    });
  }

  private async getRecentRecord(noteId: UUID): Promise<unknown | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('recentNotes', 'readonly');
      const request = transaction.objectStore('recentNotes').get(noteId);
      let value: unknown = null;
      request.onsuccess = () => { value = request.result ?? null; };
      request.onerror = () => reject(request.error ?? new Error('Unable to read cached note.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read cached note.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to read cached note.'));
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

  async putRecent(note: { id: UUID } & object): Promise<void> {
    const suppliedNoteId = (note as { noteId?: unknown }).noteId;
    const record = { ...(note as Record<string, unknown>), noteId: isString(suppliedNoteId) ? suppliedNoteId : note.id };
    await this.enqueueSnapshotMutation(() => this.write('recentNotes', (store) => store.put(record)));
  }

  async getNoteSnapshot(noteId: UUID): Promise<Note | null> {
    const value = await this.getRecentRecord(noteId);
    if (!snapshotRecord(value) || value.deletedAt) return null;
    return noteFromSnapshotRecord(value);
  }

  async putNoteSnapshot(note: Note): Promise<void> {
    await this.enqueueSnapshotMutation(async () => {
      if (!isCompleteNoteSnapshot(note) || note.deletedAt) return;
      const current = await this.getNoteSnapshot(note.id);
      if (current && current.version >= note.version) return;
      await this.write('recentNotes', (store) => store.put({ ...note, noteId: note.id }));
      await this.pruneSnapshots();
    });
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    await this.enqueueSnapshotMutation(() => this.write('recentNotes', (store) => store.delete(noteId)));
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    const records = await this.readRecentRecords();
    return records
      .filter((record) => isRecord(record) && isString(record.id) && isString(record.title) && isString(record.updatedAt))
      .map((record) => record as unknown as NoteSummary)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    await this.write('searchSelections', (store) => store.add(selection));
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<UUID, NoteDraft>();
  private readonly recent = new Map<UUID, Record<string, unknown>>();
  private readonly selections: SearchSelection[] = [];
  private snapshotMutationChain: Promise<void> = Promise.resolve();

  private enqueueSnapshotMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.snapshotMutationChain.then(operation);
    this.snapshotMutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async get(noteId: UUID): Promise<NoteDraft | null> {
    return this.drafts.get(noteId) ?? null;
  }

  async put(draft: NoteDraft): Promise<void> {
    this.drafts.set(draft.noteId, draft);
  }

  async delete(noteId: UUID): Promise<void> {
    this.drafts.delete(noteId);
  }

  async putRecent(note: { id: UUID } & object): Promise<void> {
    const suppliedNoteId = (note as { noteId?: unknown }).noteId;
    this.recent.set(note.id, { ...(note as Record<string, unknown>), noteId: isString(suppliedNoteId) ? suppliedNoteId : note.id });
  }

  async getNoteSnapshot(noteId: UUID): Promise<Note | null> {
    const value = this.recent.get(noteId);
    if (!snapshotRecord(value) || value.deletedAt) return null;
    return noteFromSnapshotRecord(value);
  }

  async putNoteSnapshot(note: Note): Promise<void> {
    await this.enqueueSnapshotMutation(async () => {
      if (!isCompleteNoteSnapshot(note) || note.deletedAt) return;
      const current = await this.getNoteSnapshot(note.id);
      if (current && current.version >= note.version) return;
      this.recent.set(note.id, { ...note, noteId: note.id });
      const ids = snapshotIdsToDelete([...this.recent.values()]);
      for (const id of ids) this.recent.delete(id);
    });
  }

  async deleteRecent(noteId: UUID): Promise<void> {
    await this.enqueueSnapshotMutation(async () => { this.recent.delete(noteId); });
  }

  async listRecent(limit = 500): Promise<NoteSummary[]> {
    return [...this.recent.values()]
      .filter((record) => isRecord(record) && isString(record.id) && isString(record.title) && isString(record.updatedAt))
      .map((record) => record as unknown as NoteSummary)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  async putSearchSelection(selection: SearchSelection): Promise<void> {
    this.selections.push(selection);
  }
}
