import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus } from 'lucide-react';
import type { NoteSummary, RealtimeNoteEvent, SearchResult } from '@qnotes/shared';
import { api } from '../api';
import { AppShell } from '../components/app-shell';
import { UNFILED_NOTEBOOK_ID } from '../components/notebook-list';
import { SearchPanel } from '../components/search-panel';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/toast';
import { useSyncRecovery } from '../hooks/use-sync-recovery';
import { useCreateNote } from '../hooks/use-create-note';
import { noteQueryKeys } from '../note-query-keys';
import { UNFILED_SEARCH_NOTEBOOK, mergeSearchParams, type AppSearchPatch, withSearchMatch, withoutSearchMatch } from '../navigation-context';
import { formatUpdatedAt } from '../lib/utils';
import { useAuth } from '../auth-context';

const starterNotePreset = {
  title: 'Welcome to Quadrate Notes',
  slug: 'welcome-to-quadrate-notes',
  contentMarkdown: '# Welcome to Quadrate Notes\n\nThis is your private Markdown workspace. Edit this note, add tags, and move it into a notebook when you are ready.\n\n## Try these next\n\n- Use **Preview** to see the rendered note.\n- Add a tag such as `getting-started`.\n- Search for this note from the home page.\n- Attach a text file or PDF to make its content searchable.\n\n:::copy{id="quick-start" title="Start the web app" lang="bash" type="command"}\npnpm dev\n:::\n',
  tags: ['getting-started'],
};

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const { toast } = useToast();
  const search = useSearch({ from: '/' });
  const selectedNotebookId = search.notebook ?? null;
  const selectedNotebookFilter = selectedNotebookId && selectedNotebookId !== UNFILED_NOTEBOOK_ID && selectedNotebookId !== UNFILED_SEARCH_NOTEBOOK ? selectedNotebookId : null;
  const unfiled = selectedNotebookId === UNFILED_NOTEBOOK_ID || selectedNotebookId === UNFILED_SEARCH_NOTEBOOK;
  const updateSearch = useCallback((params: AppSearchPatch, options: { replace?: boolean } = {}) => {
    void navigate({ to: '/', replace: options.replace ?? true, search: (previous) => mergeSearchParams(previous, { ...params, documentId: undefined, blockKey: undefined, attachmentId: undefined }) });
  }, [navigate]);
  const notesQuery = useInfiniteQuery({
    queryKey: queryKeys.home({ notebookId: selectedNotebookFilter, unfiled, tag: search.tag ?? null, limit: 50 }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.listNotes({ limit: 50, unfiled, ...(selectedNotebookFilter ? { notebookId: selectedNotebookFilter } : {}), ...(search.tag ? { tag: search.tag } : {}), ...(pageParam ? { cursor: pageParam } : {}), signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(session),
  });
  const notebooksQuery = useQuery({ queryKey: queryKeys.notebooks, queryFn: ({ signal }) => api.listNotebooks({ signal }), enabled: Boolean(session) });
  const { syncing, recover } = useSyncRecovery();
  const handleRealtimeEvent = useCallback((_event: RealtimeNoteEvent) => { void recover(); }, [recover]);
  const { create, creating } = useCreateNote({
    notebookId: selectedNotebookFilter,
    onCreated: async (note) => { await queryClient.invalidateQueries({ queryKey: queryKeys.all }); await navigate({ to: '/notes/$noteId', params: { noteId: note.id }, search: withoutSearchMatch(search) }); },
    onError: (error) => toast(error instanceof Error ? error.message : 'Unable to create note. Try again.', 'error'),
  });
  const createStarterNote = useCallback(() => { void create(starterNotePreset); }, [create]);
  const notes = useMemo(() => {
    const unique = new Map<string, NoteSummary>();
    for (const note of notesQuery.data?.pages.flatMap((page) => page.items) ?? []) unique.set(note.id, note);
    return [...unique.values()];
  }, [notesQuery.data?.pages]);
  const selectedNotebookName = useMemo(() => {
    if (selectedNotebookId === null) return 'All notes';
    if (unfiled) return 'Unfiled';
    return notebooksQuery.data?.items.find((notebook) => notebook.id === selectedNotebookId)?.name ?? 'Selected notebook';
  }, [notebooksQuery.data?.items, selectedNotebookId, unfiled]);
  const selectNote = useCallback((noteId: string) => { void navigate({ to: '/notes/$noteId', params: { noteId }, search: withoutSearchMatch(search) }); }, [navigate, search]);
  const selectResult = useCallback((result: SearchResult) => {
    void navigate({ to: '/notes/$noteId', params: { noteId: result.noteId }, search: withSearchMatch(search, { documentId: result.documentId ?? result.id, blockKey: result.blockKey, attachmentId: result.attachmentId }) });
  }, [navigate, search]);
  return <AppShell notes={notes} sidebarNotes={notes} selectedNotebookId={selectedNotebookId === UNFILED_NOTEBOOK_ID || unfiled ? UNFILED_NOTEBOOK_ID : selectedNotebookFilter} onNotebookSelect={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onNew={() => void create()} onSelectNote={selectNote} onRealtimeEvent={handleRealtimeEvent} onRealtimeReconnect={recover}>
    <div className="q-main-body">
      <div className="q-working-header"><div><p className="q-eyebrow">Current collection</p><h2>{selectedNotebookName}</h2><p className="q-subtitle">Keep useful notes, reusable blocks, and attachment context close to the work.</p></div><Button size="lg" onClick={() => void create()}><Plus size={18} aria-hidden="true" />New note</Button></div>
      <div className="q-home-filters"><SearchPanel notebookId={selectedNotebookFilter} unfiled={unfiled} selectedNotebookId={selectedNotebookId} initialQuery={search.q ?? ''} initialTag={search.tag ?? ''} initialSource={search.source} onNotebookChange={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onSearchParamsChange={updateSearch} onResultSelect={selectResult} /><label className="q-home-notebook-filter" htmlFor="home-notebook-filter"><span className="q-label">Browse collection</span><select id="home-notebook-filter" aria-label="Filter notes by notebook" value={selectedNotebookId ?? ''} onChange={(event) => updateSearch({ notebook: event.target.value || undefined })}><option value="">All notes</option><option value={UNFILED_NOTEBOOK_ID}>Unfiled</option>{notebooksQuery.data?.items.map((notebook) => <option value={notebook.id} key={notebook.id}>{notebook.name}</option>)}</select></label></div>
      {!search.q && <section className="q-card q-card-pad q-home-notes" aria-labelledby="notes-heading"><div className="q-section-heading"><h2 id="notes-heading">{selectedNotebookId === null ? (syncing ? 'Refreshing your notes…' : 'All notes') : selectedNotebookName}</h2><span className="q-small">{notes.length} loaded</span></div>{notesQuery.isLoading ? <div className="q-empty">Loading your notes…</div> : notesQuery.error ? <div className="q-error" role="alert">Unable to load this collection right now. Please try again. <Button type="button" variant="outline" size="sm" onClick={() => void notesQuery.refetch()}>Retry</Button></div> : notes.length === 0 ? selectedNotebookId === null ? <div className="q-empty q-empty-welcome"><BookOpen size={28} aria-hidden="true" /><h3>Make your first note</h3><p>Capture an idea, keep a useful reference, or start with a small Markdown workspace.</p><div className="q-empty-actions"><Button size="lg" onClick={() => void create()} disabled={creating}><Plus size={18} aria-hidden="true" />New note</Button><Button variant="outline" size="lg" onClick={createStarterNote} disabled={creating}><BookOpen size={17} aria-hidden="true" />Use starter note</Button></div><span className="q-field-help">The starter note is private and fully editable.</span></div> : <div className="q-empty"><strong>No notes in {selectedNotebookName}.</strong><p>Create a note to start this collection.</p><Button className="q-empty-action" onClick={() => void create()} disabled={creating}><Plus size={17} aria-hidden="true" />New note</Button></div> : <><div className="q-note-card-grid">{notes.map((note) => <button className="q-note-item q-note-card" key={note.id} onClick={() => selectNote(note.id)}><span className="q-note-item-heading"><span className="q-note-item-title">{note.title}</span><span className="q-note-item-time">{formatUpdatedAt(note.updatedAt)}</span></span><span className="q-note-item-excerpt">{note.excerpt || 'Empty note'}</span><span className="q-note-item-context">{note.notebookId ? notebooksQuery.data?.items.find((notebook) => notebook.id === note.notebookId)?.name ?? 'Notebook' : 'Unfiled'}{note.tags.length ? ` · ${note.tags.slice(0, 3).join(' · ')}` : ''}</span><span className="q-tag-row">{note.tags.slice(0, 3).map((tag) => <Badge key={tag}>{tag}</Badge>)}</span></button>)}</div>{notesQuery.hasNextPage && <Button variant="outline" onClick={() => void notesQuery.fetchNextPage()} disabled={notesQuery.isFetchingNextPage}>{notesQuery.isFetchingNextPage ? 'Loading more…' : 'Load more notes'}</Button>}</>}</section>}
    </div>
  </AppShell>;
}
