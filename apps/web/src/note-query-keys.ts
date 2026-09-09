export interface WorkspaceQueryKeys {
  root: readonly ['qnotes', string];
  all: readonly ['qnotes', string, 'notes'];
  homeFamily: readonly ['qnotes', string, 'notes', 'home'];
  home: (filters: { notebookId: string | null; unfiled: boolean; tag?: string | null; limit: number }) => readonly ['qnotes', string, 'notes', 'home', { notebookId: string | null; unfiled: boolean; tag: string | null; limit: number }];
  sidebarFamily: readonly ['qnotes', string, 'notes', 'sidebar'];
  sidebar: readonly ['qnotes', string, 'notes', 'sidebar', { limit: number }];
  trashFamily: readonly ['qnotes', string, 'notes', 'trash'];
  trash: (limit: number) => readonly ['qnotes', string, 'notes', 'trash', { limit: number; deletedOnly: true }];
  note: (noteId: string) => readonly ['qnotes', string, 'notes', 'detail', string];
  notebooks: readonly ['qnotes', string, 'notebooks'];
  attachments: (noteId: string) => readonly ['qnotes', string, 'attachments', string];
  share: (noteId: string) => readonly ['qnotes', string, 'note-share', string];
  searchFamily: readonly ['qnotes', string, 'search'];
  search: (query: string, filters: unknown, limit: number, maxPerNote: number) => readonly ['qnotes', string, 'search', string, unknown, { limit: number; maxPerNote: number }];
  searchContext: (documentId: string) => readonly ['qnotes', string, 'search-context', string];
}

export const NOTE_DETAIL_STALE_TIME = 30_000;

interface QueryForInvalidation {
  queryKey: readonly unknown[];
  state: { data: unknown };
}

type QueryInvalidationFilters =
  | { queryKey: readonly unknown[] }
  | { predicate: (query: QueryForInvalidation) => boolean };

interface NoteQueryClient {
  invalidateQueries: (filters: QueryInvalidationFilters) => Promise<unknown>;
}

export const noteQueryKeys = {
  root: ['qnotes'] as const,
  forUser: (userId: string): WorkspaceQueryKeys => ({
    root: ['qnotes', userId],
    all: ['qnotes', userId, 'notes'],
    homeFamily: ['qnotes', userId, 'notes', 'home'],
    home: (filters) => ['qnotes', userId, 'notes', 'home', { notebookId: filters.notebookId, unfiled: filters.unfiled, tag: filters.tag ?? null, limit: filters.limit }],
    sidebarFamily: ['qnotes', userId, 'notes', 'sidebar'],
    sidebar: ['qnotes', userId, 'notes', 'sidebar', { limit: 50 }],
    trashFamily: ['qnotes', userId, 'notes', 'trash'],
    trash: (limit) => ['qnotes', userId, 'notes', 'trash', { limit, deletedOnly: true }],
    note: (noteId) => ['qnotes', userId, 'notes', 'detail', noteId],
    notebooks: ['qnotes', userId, 'notebooks'],
    attachments: (noteId) => ['qnotes', userId, 'attachments', noteId],
    share: (noteId) => ['qnotes', userId, 'note-share', noteId],
    searchFamily: ['qnotes', userId, 'search'],
    search: (query, filters, limit, maxPerNote) => ['qnotes', userId, 'search', query, filters, { limit, maxPerNote }],
    searchContext: (documentId) => ['qnotes', userId, 'search-context', documentId],
  }),
};

function searchContextForNotes(userId: string, noteIds: Iterable<string>): QueryInvalidationFilters {
  const changedNoteIds = new Set(noteIds);
  return {
    predicate: ({ queryKey, state }) => {
      if (queryKey[0] !== 'qnotes' || queryKey[1] !== userId || queryKey[2] !== 'search-context') return false;
      const data = state.data;
      return typeof data === 'object' && data !== null && 'noteId' in data && typeof data.noteId === 'string' && changedNoteIds.has(data.noteId);
    },
  };
}

/** Invalidate note collections without matching any note-detail query. */
export async function refreshNoteCollections(queryClient: NoteQueryClient, userId: string): Promise<void> {
  const keys = noteQueryKeys.forUser(userId);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.homeFamily }),
    queryClient.invalidateQueries({ queryKey: keys.sidebarFamily }),
    queryClient.invalidateQueries({ queryKey: keys.trashFamily }),
    queryClient.invalidateQueries({ queryKey: keys.searchFamily }),
    queryClient.invalidateQueries({ queryKey: keys.notebooks }),
  ]);
}

/** Invalidate only views whose result can be affected by one note mutation. */
export async function refreshNoteViews(queryClient: NoteQueryClient, userId: string, noteId: string): Promise<void> {
  const keys = noteQueryKeys.forUser(userId);
  await refreshNoteCollections(queryClient, userId);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.note(noteId) }),
    queryClient.invalidateQueries(searchContextForNotes(userId, [noteId])),
  ]);
}

/** Refresh all affected views once for a deduplicated set of changed notes. */
export async function refreshNoteViewsForNotes(queryClient: NoteQueryClient, userId: string, noteIds: Iterable<string>): Promise<void> {
  const keys = noteQueryKeys.forUser(userId);
  const uniqueNoteIds = [...new Set(noteIds)];
  await refreshNoteCollections(queryClient, userId);
  await Promise.all([
    ...uniqueNoteIds.map((noteId) => queryClient.invalidateQueries({ queryKey: keys.note(noteId) })),
    queryClient.invalidateQueries(searchContextForNotes(userId, uniqueNoteIds)),
  ]);
}
