import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, BookOpen, ChevronRight, FileText, Inbox, Library, Plus } from 'lucide-react';
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
import { NOTE_DETAIL_STALE_TIME, noteQueryKeys, refreshNoteCollections } from '../note-query-keys';
import { UNFILED_SEARCH_NOTEBOOK, mergeSearchParams, type AppSearchPatch, withSearchMatch, withoutSearchMatch } from '../navigation-context';
import { formatUpdatedAt } from '../lib/utils';
import { requestEditorFocus } from '../lib/editor-focus';
import { useAuth } from '../auth-context';

const starterNotePreset = {
  title: 'Welcome to QNotes',
  slug: 'welcome-to-quadrate-notes',
  contentMarkdown: '# Welcome to QNotes\n\nThis is your private Markdown workspace. Edit this note, add tags, and move it into a notebook when you are ready.\n\n## Try these next\n\n- Use **Preview** to see the rendered note.\n- Add a tag such as `getting-started`.\n- Search for this note from the home page.\n- Attach a text file or PDF to make its content searchable.\n\n:::copy{id="quick-start" title="Start the web app" lang="bash" type="command"}\npnpm dev\n:::\n',
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
  const hasCollectionFilter = selectedNotebookId !== null || Boolean(search.tag || search.source);
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
    onCreated: async (note) => { await refreshNoteCollections(queryClient, userId); requestEditorFocus(note.id); await navigate({ to: '/notes/$noteId', params: { noteId: note.id }, search: withoutSearchMatch(search) }); },
    onError: (error) => toast(error instanceof Error ? error.message : 'Unable to create note. Try again.', 'error'),
  });
  const createStarterNote = useCallback(() => { void create(starterNotePreset); }, [create]);
  const notes = useMemo(() => {
    const unique = new Map<string, NoteSummary>();
    for (const note of notesQuery.data?.pages.flatMap((page) => page.items) ?? []) unique.set(note.id, note);
    return [...unique.values()];
  }, [notesQuery.data?.pages]);
  const isTrueFirstRun = !hasCollectionFilter && !notesQuery.isLoading && !notesQuery.error && notes.length === 0;
  const selectedNotebookName = useMemo(() => {
    if (selectedNotebookId === null) return 'All notes';
    if (unfiled) return 'Unfiled';
    return notebooksQuery.data?.items.find((notebook) => notebook.id === selectedNotebookId)?.name ?? 'Selected notebook';
  }, [notebooksQuery.data?.items, selectedNotebookId, unfiled]);
  const collectionOptions = useMemo(() => [
    { id: null, label: 'All notes', Icon: Library },
    { id: UNFILED_NOTEBOOK_ID, label: 'Unfiled', Icon: Inbox },
    ...(notebooksQuery.data?.items ?? []).map((notebook) => ({ id: notebook.id, label: notebook.name, Icon: BookOpen })),
  ], [notebooksQuery.data?.items]);
  const selectNote = useCallback((noteId: string) => { void navigate({ to: '/notes/$noteId', params: { noteId }, search: withoutSearchMatch(search) }); }, [navigate, search]);
  const prefetchNote = useCallback((noteId: string) => {
    if (!session) return;
    void queryClient.prefetchQuery({
      queryKey: queryKeys.note(noteId),
      queryFn: ({ signal }) => api.getNote(noteId, { includeDeleted: true, signal }),
      staleTime: NOTE_DETAIL_STALE_TIME,
    });
  }, [queryClient, queryKeys, session]);
  const selectResult = useCallback((result: SearchResult) => {
    void navigate({ to: '/notes/$noteId', params: { noteId: result.noteId }, search: withSearchMatch(search, { documentId: result.documentId ?? result.id, blockKey: result.blockKey, attachmentId: result.attachmentId }) });
  }, [navigate, search]);
  return <AppShell notes={notes} sidebarNotes={notes} selectedNotebookId={selectedNotebookId === UNFILED_NOTEBOOK_ID || unfiled ? UNFILED_NOTEBOOK_ID : selectedNotebookFilter} onNotebookSelect={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onNew={() => void create()} onSelectNote={selectNote} onRealtimeEvent={handleRealtimeEvent} onRealtimeReconnect={recover}>
    <div className="q-main-body">
      <div className="q-working-header q-home-hero"><div><p className="q-eyebrow">Your notes</p><h2>{selectedNotebookName}</h2><p className="q-subtitle">Keep useful notes, reusable blocks, and attachment context close to the work.</p></div><Button size="lg" onClick={() => void create()}><Plus size={18} aria-hidden="true" />New note</Button></div>
      <div className="q-home-filters"><SearchPanel notebookId={selectedNotebookFilter} unfiled={unfiled} selectedNotebookId={selectedNotebookId} notebooks={notebooksQuery.data?.items ?? []} showNotebookFilter={false} showInlineMobileFilters initialQuery={search.q ?? ''} initialTag={search.tag ?? ''} initialSource={search.source} onNotebookChange={(notebookId) => updateSearch({ notebook: notebookId ?? undefined }, { replace: false })} onSearchParamsChange={updateSearch} onResultSelect={selectResult} /><label className="q-home-notebook-filter" htmlFor="home-notebook-filter"><span className="q-label">Browse collection</span><select id="home-notebook-filter" aria-label="Filter notes by notebook" value={selectedNotebookId ?? ''} onChange={(event) => updateSearch({ notebook: event.target.value || undefined })}><option value="">All notes</option><option value={UNFILED_NOTEBOOK_ID}>Unfiled</option>{notebooksQuery.data?.items.map((notebook) => <option value={notebook.id} key={notebook.id}>{notebook.name}</option>)}</select></label></div>
      <nav className="q-mobile-collections" aria-label="Choose collection">{collectionOptions.map(({ id, label, Icon }) => <button type="button" className="q-collection-chip" data-active={selectedNotebookId === id || (id === UNFILED_NOTEBOOK_ID && unfiled)} aria-pressed={selectedNotebookId === id || (id === UNFILED_NOTEBOOK_ID && unfiled)} key={id ?? 'all'} onClick={() => updateSearch({ notebook: id ?? undefined }, { replace: false })}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}</nav>
      {!search.q && <section className="q-card q-card-pad q-home-notes" aria-labelledby="notes-heading"><div className="q-section-heading"><div className="q-section-heading-main"><h2 id="notes-heading">Notes</h2><span className="q-count-badge" aria-label={`${notes.length} notes loaded`}>{notes.length}</span></div><span className={`q-note-list-status${syncing ? ' q-note-list-status-syncing' : ''}`} aria-live="polite"><ArrowUpDown size={15} aria-hidden="true" />{syncing ? 'Syncing…' : 'Recently updated'}</span></div>{notesQuery.isLoading ? <div className="q-empty">Loading your notes…</div> : notesQuery.error ? <div className="q-error" role="alert">Unable to load this collection right now. Please try again. <Button type="button" variant="outline" size="sm" onClick={() => void notesQuery.refetch()}>Retry</Button></div> : notes.length === 0 ? isTrueFirstRun ? <div className="q-empty q-empty-welcome"><BookOpen size={28} aria-hidden="true" /><h3>Make your first note</h3><p>Capture an idea, keep a useful reference, or start with a small Markdown workspace. Markdown, notebooks, full-workspace search, and private attachments are ready when you are.</p><div className="q-empty-actions"><Button size="lg" onClick={() => void create()} disabled={creating}><Plus size={18} aria-hidden="true" />New note</Button><Button variant="outline" size="lg" onClick={createStarterNote} disabled={creating}><BookOpen size={17} aria-hidden="true" />Use starter note</Button></div><span className="q-field-help">The starter note is private and fully editable.</span></div> : <div className="q-empty"><strong>{hasCollectionFilter && !selectedNotebookId ? 'No notes match the current filters.' : `No notes in ${selectedNotebookName}.`}</strong><p>Try clearing a filter or create a note to start this collection.</p><Button className="q-empty-action" onClick={() => void create()} disabled={creating}><Plus size={17} aria-hidden="true" />New note</Button></div> : <><div className="q-note-card-grid">{notes.map((note) => { const notebookName = note.notebookId ? notebooksQuery.data?.items.find((notebook) => notebook.id === note.notebookId)?.name ?? 'Notebook' : 'Unfiled'; return <button type="button" className="q-note-item q-note-card" key={note.id} onClick={() => selectNote(note.id)} onPointerEnter={() => prefetchNote(note.id)} onFocus={() => prefetchNote(note.id)}><span className="q-note-item-icon" aria-hidden="true"><FileText size={16} /></span><span className="q-note-item-heading"><span className="q-note-item-title">{note.title}</span><span className="q-note-item-time">{formatUpdatedAt(note.updatedAt)}</span></span><span className="q-note-item-excerpt">{note.excerpt || 'Empty note'}</span><span className="q-note-card-meta"><span className="q-note-card-notebook q-badge">{notebookName}</span><span className="q-tag-row">{note.tags.slice(0, 2).map((tag) => <Badge key={tag}>{tag}</Badge>)}{note.tags.length > 2 && <span className="q-badge q-tag-more">+{note.tags.length - 2}</span>}</span></span><span className="q-note-item-chevron" aria-hidden="true"><ChevronRight size={18} /></span></button>; })}</div>{notesQuery.hasNextPage && <Button variant="outline" onClick={() => void notesQuery.fetchNextPage()} disabled={notesQuery.isFetchingNextPage}>{notesQuery.isFetchingNextPage ? 'Loading more…' : 'Load more notes'}</Button>}</>}</section>}
    </div>
  </AppShell>;
}
