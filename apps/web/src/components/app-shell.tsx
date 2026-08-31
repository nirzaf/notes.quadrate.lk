import type { PropsWithChildren } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { NoteSummary, RealtimeNoteEvent } from '@qnotes/shared';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth-context';
import { useNoteRealtime } from '../hooks/use-note-realtime';
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
  const defaultRealtimeEvent = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['notes'] }); }, [queryClient]);
  useNoteRealtime(onRealtimeEvent ?? defaultRealtimeEvent, onRealtimeReconnect);
  const create = onNew ?? (() => void navigate({ to: '/' }));
  const select = onSelectNote ?? ((noteId: string) => void navigate({ to: '/notes/$noteId', params: { noteId } }));
  return <div className="q-app">
    <div className="q-shell">
      <aside className="q-sidebar">
        <Link to="/" className="q-brand" aria-label="Quadrate Notes home"><span className="q-brand-mark">qn</span><span className="q-brand-word">Quadrate Notes</span></Link>
        <div className="q-sidebar-search"><Link to="/" className="q-button q-button-outline" style={{ width: '100%' }}>Search notes <span className="q-search-kbd">⌘K</span></Link></div>
        <NoteList notes={notes} activeNoteId={activeNoteId} onNew={create} onSelect={select} />
        <div className="q-sidebar-footer"><span className="q-user-email" title={session?.user.email ?? ''}>{session?.user.email}</span><Button variant="ghost" size="sm" onClick={() => { void signOut().catch((error: unknown) => toast(error instanceof Error ? error.message : 'Unable to sign out.', 'error')); }}>Sign out</Button></div>
      </aside>
      <main className="q-main"><header className="q-main-header"><h1 className="q-main-title">{title}</h1><div className="q-status"><span className="q-status-dot" />Private workspace</div></header>{children}</main>
    </div>
    <nav className="q-mobile-nav" aria-label="Mobile navigation"><Link to="/" data-active={location.pathname === '/'}>Notes</Link><Link to="/settings/tokens" data-active={location.pathname.startsWith('/settings')}>Tokens</Link><button onClick={() => { void signOut(); }}>Sign out</button></nav>
    <button className="q-floating-new" onClick={create} aria-label="Create a new note">+</button>
  </div>;
}
