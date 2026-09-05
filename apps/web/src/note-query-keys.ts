export interface WorkspaceQueryKeys {
  root: readonly ['qnotes', string];
  all: readonly ['qnotes', string, 'notes'];
  home: (filters: { notebookId: string | null; unfiled: boolean; tag?: string | null; limit: number }) => readonly ['qnotes', string, 'notes', 'home', { notebookId: string | null; unfiled: boolean; tag: string | null; limit: number }];
  sidebar: readonly ['qnotes', string, 'notes', 'sidebar', { limit: number }];
  trash: (limit: number) => readonly ['qnotes', string, 'notes', 'trash', { limit: number; deletedOnly: true }];
  note: (noteId: string) => readonly ['qnotes', string, 'notes', 'detail', string];
  notebooks: readonly ['qnotes', string, 'notebooks'];
  attachments: (noteId: string) => readonly ['qnotes', string, 'attachments', string];
  search: (query: string, filters: unknown, limit: number, maxPerNote: number) => readonly ['qnotes', string, 'search', string, unknown, { limit: number; maxPerNote: number }];
  searchContext: (documentId: string) => readonly ['qnotes', string, 'search-context', string];
}

export const noteQueryKeys = {
  root: ['qnotes'] as const,
  forUser: (userId: string): WorkspaceQueryKeys => ({
    root: ['qnotes', userId],
    all: ['qnotes', userId, 'notes'],
    home: (filters) => ['qnotes', userId, 'notes', 'home', { notebookId: filters.notebookId, unfiled: filters.unfiled, tag: filters.tag ?? null, limit: filters.limit }],
    sidebar: ['qnotes', userId, 'notes', 'sidebar', { limit: 50 }],
    trash: (limit) => ['qnotes', userId, 'notes', 'trash', { limit, deletedOnly: true }],
    note: (noteId) => ['qnotes', userId, 'notes', 'detail', noteId],
    notebooks: ['qnotes', userId, 'notebooks'],
    attachments: (noteId) => ['qnotes', userId, 'attachments', noteId],
    search: (query, filters, limit, maxPerNote) => ['qnotes', userId, 'search', query, filters, { limit, maxPerNote }],
    searchContext: (documentId) => ['qnotes', userId, 'search-context', documentId],
  }),
};

/** Invalidate only views whose result can be affected by one note mutation. */
export async function refreshNoteViews(queryClient: { invalidateQueries: (filters: { queryKey: readonly unknown[] }) => Promise<unknown> }, userId: string, noteId: string): Promise<void> {
  const keys = noteQueryKeys.forUser(userId);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.all }),
    queryClient.invalidateQueries({ queryKey: keys.note(noteId) }),
    queryClient.invalidateQueries({ queryKey: ['qnotes', userId, 'search'] }),
    queryClient.invalidateQueries({ queryKey: ['qnotes', userId, 'search-context'] }),
  ]);
}
