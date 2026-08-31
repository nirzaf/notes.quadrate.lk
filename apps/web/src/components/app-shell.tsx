import type { PropsWithChildren } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { NoteSummary, RealtimeNoteEvent } from '@qnotes/shared';
import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth-context';
import { useNoteRealtime } from '../hooks/use-note-realtime';
import { NotebookList, UNFILED_NOTEBOOK_ID } from './notebook-list';
import { NoteList } from './note-list';
import { Button } from './ui/button';
import { useToast } from './ui/toast';

interface AppShellProps extends PropsWithChildren {
  title?: string;
  notes?: NoteSummary[];
  activeNoteId?: string;
  onNew?: () => void;
  onSelectNote?: (noteId: string) => void;
  onRealtimeEvent?: (event: RealtimeNoteEvent) => void | Promise<void>;
  onRealtimeReconnect?: () => void;
}

export function AppShell({ title = 'Quadrate Notes', notes = [], activeNoteId, onNew, onSelectNote, onRealtimeEvent, onRealtimeReconnect, children }: AppShellProps): JSX.Element {
  const { session, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const notebooksQuery = useQuery({ queryKey: ['notebooks'], queryFn: () => api.listNotebooks() });
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const defaultRealtimeEvent = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['notes'] }); }, [queryClient]);
  useNoteRealtime(onRealtimeEvent ?? defaultRealtimeEvent, onRealtimeReconnect);
  const create = onNew ?? (() => void navigate({ to: '/' }));
  const select = onSelectNote ?? ((noteId: string) => void navigate({ to: '/notes/$noteId', params: { noteId } }));
  const noteCounts = useMemo(() => notes.reduce<Record<string, number>>((counts, note) => {
    if (note.notebookId) counts[note.notebookId] = (counts[note.notebookId] ?? 0) + 1;
    return counts;
  }, {}), [notes]);
  const filteredNotes = selectedNotebookId === null
    ? notes
    : selectedNotebookId === UNFILED_NOTEBOOK_ID
      ? notes.filter((note) => !note.notebookId)
      : notes.filter((note) => note.notebookId === selectedNotebookId);
  const createNotebook = useCallback(async (name: string) => {
    try {
      const notebook = await api.createNotebook({ name });
      await queryClient.invalidateQueries({ queryKey: ['notebooks'] });
      toast(`Notebook “${notebook.name}” created.`, 'success');
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Unable to create notebook.', 'error');
      throw error;
    }
  }, [queryClient, toast]);
  return <div className="q-app">
    <div className="q-shell">
      <aside className="q-sidebar">
        <Link to="/" className="q-brand" aria-label="Quadrate Notes home"><span className="q-brand-mark">qn</span><span className="q-brand-word">Quadrate Notes</span></Link>
        <div className="q-sidebar-search"><Link to="/" className="q-button q-button-outline" style={{ width: '100%' }}>Search notes <span className="q-search-kbd">⌘K</span></Link></div>
        <NotebookList notebooks={notebooksQuery.data?.items ?? []} selectedNotebookId={selectedNotebookId} allCount={notes.length} unfiledCount={notes.filter((note) => !note.notebookId).length} noteCounts={noteCounts} onSelect={setSelectedNotebookId} onCreate={createNotebook} />
        <NoteList notes={filteredNotes} activeNoteId={activeNoteId} onNew={create} onSelect={select} />
        <div className="q-sidebar-footer"><span className="q-user-email" title={session?.user.email ?? ''}>{session?.user.email}</span><Button variant="ghost" size="sm" onClick={() => { void signOut().catch((error: unknown) => toast(error instanceof Error ? error.message : 'Unable to sign out.', 'error')); }}>Sign out</Button></div>
      </aside>
      <main className="q-main"><header className="q-main-header"><h1 className="q-main-title">{title}</h1><div className="q-status"><span className="q-status-dot" />Private workspace</div></header>{children}</main>
    </div>
    <nav className="q-mobile-nav" aria-label="Mobile navigation"><Link to="/" data-active={location.pathname === '/'}>Notes</Link><Link to="/settings/tokens" data-active={location.pathname.startsWith('/settings')}>Tokens</Link><button onClick={() => { void signOut(); }}>Sign out</button></nav>
    <button className="q-floating-new" onClick={create} aria-label="Create a new note">+</button>
  </div>;
}
