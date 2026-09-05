import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@qnotes/shared';
import { api } from '../api';
import { AppShell } from '../components/app-shell';
import { SearchPanel } from '../components/search-panel';
import { UNFILED_SEARCH_NOTEBOOK, mergeSearchParams, type AppSearchPatch, withSearchMatch } from '../navigation-context';
import { noteQueryKeys } from '../note-query-keys';
import { useAuth } from '../auth-context';

export function SearchPage(): JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ from: '/search' });
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const notebooksQuery = useQuery({ queryKey: queryKeys.notebooks, queryFn: ({ signal }) => api.listNotebooks({ signal }), enabled: Boolean(session) });
  const notesQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }), enabled: Boolean(session) });
  const selectedNotebookId = search.notebook ?? null;
  const updateSearch = useCallback((params: AppSearchPatch, options: { replace?: boolean } = {}) => {
    void navigate({ to: '/search', replace: options.replace ?? true, search: (previous) => mergeSearchParams(previous, { ...params, documentId: undefined, blockKey: undefined, attachmentId: undefined }) });
  }, [navigate]);
  const selectResult = useCallback((result: SearchResult) => {
    void navigate({ to: '/notes/$noteId', params: { noteId: result.noteId }, search: withSearchMatch(search, { documentId: result.documentId ?? result.id, blockKey: result.blockKey, attachmentId: result.attachmentId }) });
  }, [navigate, search]);
  return <AppShell title="Search" notes={notesQuery.data?.items ?? []} selectedNotebookId={selectedNotebookId} onNotebookSelect={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id }, search })}>
    <div className="q-main-body">
      <div className="q-working-header"><div><p className="q-eyebrow">Workspace search</p><h2>Find the exact part you need.</h2><p className="q-subtitle">Search notes, reusable blocks, code, and private attachment text.</p></div></div>
    <SearchPanel notebookId={selectedNotebookId && selectedNotebookId !== UNFILED_SEARCH_NOTEBOOK ? selectedNotebookId : null} unfiled={selectedNotebookId === UNFILED_SEARCH_NOTEBOOK} selectedNotebookId={selectedNotebookId} notebooks={notebooksQuery.data?.items ?? []} initialQuery={search.q ?? ''} initialTag={search.tag ?? ''} initialSource={search.source} onNotebookChange={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onSearchParamsChange={updateSearch} onResultSelect={selectResult} />
    </div>
  </AppShell>;
}
