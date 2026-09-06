import type { PropsWithChildren } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { NoteSummary, RealtimeNoteEvent } from '@qnotes/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth-context';
import { useNoteRealtime } from '../hooks/use-note-realtime';
import { NotebookList, UNFILED_NOTEBOOK_ID } from './notebook-list';
import { NoteList } from './note-list';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import { useCreateNote } from '../hooks/use-create-note';
import { noteQueryKeys, refreshNoteViews } from '../note-query-keys';
import { DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Sheet, SheetContent } from './ui/sheet';
import { searchShortcutLabel, withoutSearchMatch, type AppSearchParams } from '../navigation-context';

interface AppShellProps extends PropsWithChildren {
  title?: string;
  notes?: NoteSummary[];
  sidebarNotes?: NoteSummary[];
  activeNoteId?: string;
  selectedNotebookId?: string | null;
  onNotebookSelect?: (notebookId: string | null) => void;
  onNew?: () => void | Promise<void>;
  onSelectNote?: (noteId: string) => void;
  onRealtimeEvent?: (event: RealtimeNoteEvent) => void | Promise<void>;
  onRealtimeReconnect?: () => void;
}

export function AppShell({ title = 'Quadrate Notes', notes = [], sidebarNotes: sidebarNotesProp, activeNoteId, selectedNotebookId: selectedNotebookIdProp, onNotebookSelect, onNew, onSelectNote, onRealtimeEvent, onRealtimeReconnect, children }: AppShellProps): JSX.Element {
  const { session, signOut } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const notebooksQuery = useQuery({ queryKey: queryKeys.notebooks, queryFn: ({ signal }) => api.listNotebooks({ signal }), enabled: Boolean(session) });
  const [localSelectedNotebookId, setLocalSelectedNotebookId] = useState<string | null>(null);
  const selectedNotebookId = selectedNotebookIdProp === undefined ? localSelectedNotebookId : selectedNotebookIdProp;
  const sidebarNotes = sidebarNotesProp ?? notes;
  const selectNotebook = useCallback((notebookId: string | null) => {
    if (selectedNotebookIdProp === undefined) setLocalSelectedNotebookId(notebookId);
    onNotebookSelect?.(notebookId);
  }, [onNotebookSelect, selectedNotebookIdProp]);
  const defaultRealtimeEvent = useCallback((event: RealtimeNoteEvent) => { void refreshNoteViews(queryClient, userId, event.noteId).catch(() => undefined); }, [queryClient, userId]);
  const defaultRealtimeReconnect = useCallback(() => { void Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.all }), queryClient.invalidateQueries({ queryKey: ['qnotes', userId, 'search'] })]).catch(() => undefined); }, [queryClient, queryKeys.all, userId]);
  useNoteRealtime(onRealtimeEvent ?? defaultRealtimeEvent, onRealtimeReconnect ?? defaultRealtimeReconnect);
  const defaultCreate = useCreateNote({ notebookId: null, onCreated: async (note) => { await queryClient.invalidateQueries({ queryKey: queryKeys.all }); await navigate({ to: '/notes/$noteId', params: { noteId: note.id } }); }, onError: (error) => toast(error instanceof Error ? error.message : 'Unable to create note. Try again.', 'error') });
  const create = onNew ?? (() => void defaultCreate.create());
  const select = onSelectNote ?? ((noteId: string) => void navigate({ to: '/notes/$noteId', params: { noteId } }));
  useEffect(() => {
    const focusGlobalSearch = (event: KeyboardEvent) => {
      if (event.isComposing || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target;
      if (target instanceof Element && (target.closest('.cm-editor') || target.closest('[contenteditable="true"]'))) return;
      event.preventDefault();
      if (location.pathname === '/' || location.pathname === '/search') {
        const input = document.getElementById('global-search-input') as HTMLInputElement | null;
        if (input) { input.focus(); input.select(); return; }
      }
      void navigate({ to: '/search', search: withoutSearchMatch(location.search as AppSearchParams) });
    };
    window.addEventListener('keydown', focusGlobalSearch);
    return () => window.removeEventListener('keydown', focusGlobalSearch);
  }, [location.pathname, location.search, navigate]);
  const filteredNotes = selectedNotebookId === null
    ? sidebarNotes
    : selectedNotebookId === UNFILED_NOTEBOOK_ID
      ? sidebarNotes.filter((note) => !note.notebookId)
      : sidebarNotes.filter((note) => note.notebookId === selectedNotebookId);
  const createNotebook = useCallback(async (name: string) => {
    try {
      const notebook = await api.createNotebook({ name });
      await queryClient.invalidateQueries({ queryKey: queryKeys.notebooks });
      toast(`Notebook “${notebook.name}” created.`, 'success');
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Unable to create notebook.', 'error');
      throw error;
    }
  }, [queryClient, toast]);
  return <div className="q-app">
    <div className="q-shell">
      <aside className="q-sidebar">
        <Link to="/" search={withoutSearchMatch(location.search as AppSearchParams)} className="q-brand" aria-label="Quadrate Notes home"><span className="q-brand-mark">qn</span><span className="q-brand-word">Quadrate Notes</span></Link>
        <div className="q-sidebar-search"><Link to="/search" search={withoutSearchMatch(location.search as AppSearchParams)} className="q-button q-button-outline" style={{ width: '100%' }}>Search notes <span className="q-search-kbd">{searchShortcutLabel()}</span></Link></div>
        <NotebookList idPrefix="desktop" notebooks={notebooksQuery.data?.items ?? []} selectedNotebookId={selectedNotebookId} onSelect={selectNotebook} onCreate={createNotebook} />
        <Link to="/trash" className="q-destination-link" data-active={location.pathname === '/trash'}>Trash</Link>
        <Link to="/settings/integrations" className="q-destination-link" data-active={location.pathname.startsWith('/settings')}>Integrations</Link>
        <NoteList notes={filteredNotes} activeNoteId={activeNoteId} onNew={create} onSelect={select} />
        <div className="q-sidebar-footer"><span className="q-user-email" title={session?.user.email ?? ''}>{session?.user.email}</span><Button variant="ghost" size="sm" onClick={() => { void signOut().catch((error: unknown) => toast(error instanceof Error ? error.message : 'Unable to sign out.', 'error')); }}>Sign out</Button></div>
      </aside>
      <main className="q-main" data-screenshot-capture-target="true"><header className="q-main-header"><h1 className="q-main-title">{title}</h1><div className="q-status"><span className="q-status-dot" />Private workspace</div></header>{children}</main>
    </div>
    <nav className="q-mobile-nav" aria-label="Mobile navigation"><Link to="/" search={withoutSearchMatch(location.search as AppSearchParams)} data-active={location.pathname === '/'}>Notes</Link><Link to="/search" search={withoutSearchMatch(location.search as AppSearchParams)} data-active={location.pathname === '/search'}>Search</Link><button type="button" data-active={location.pathname === '/trash' || location.pathname.startsWith('/settings')} aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>More</button></nav>
    <button className="q-floating-new" onClick={() => { void create(); }} aria-label="Create a new note">+</button>
    <Sheet open={moreOpen} onOpenChange={setMoreOpen}><SheetContent side="bottom" className="q-mobile-more"><DialogHeader><DialogTitle>More workspace tools</DialogTitle><DialogDescription>Notebooks, integrations, Trash, and account actions.</DialogDescription></DialogHeader><NotebookList idPrefix="mobile" notebooks={notebooksQuery.data?.items ?? []} selectedNotebookId={selectedNotebookId} onSelect={(notebookId) => { selectNotebook(notebookId); setMoreOpen(false); }} onCreate={createNotebook} /><div className="q-mobile-more-links"><Link to="/settings/integrations" onClick={() => setMoreOpen(false)}>Integrations</Link><Link to="/trash" onClick={() => setMoreOpen(false)}>Trash</Link><button type="button" onClick={() => { setMoreOpen(false); void signOut().catch((error: unknown) => toast(error instanceof Error ? error.message : 'Unable to sign out.', 'error')); }}>Sign out</button></div></SheetContent></Sheet>
  </div>;
}
