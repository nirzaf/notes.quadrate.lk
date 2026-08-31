import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { getDeviceId } from '../indexed-db';
import { AppShell } from '../components/app-shell';
import { SearchPanel } from '../components/search-panel';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/toast';
import { useSyncRecovery } from '../hooks/use-sync-recovery';
import type { RealtimeNoteEvent } from '@qnotes/shared';

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const notesQuery = useQuery({ queryKey: ['notes'], queryFn: () => api.listNotes({ limit: 500 }) });
  const { syncing, recover } = useSyncRecovery();
  const handleRealtimeEvent = useCallback((_event: RealtimeNoteEvent) => { void recover(); }, [recover]);
  const createNote = useCallback(async () => {
    try {
      const note = await api.createNote({ title: 'Untitled note', slug: `untitled-note-${crypto.randomUUID().slice(0, 8)}`, contentMarkdown: '', tags: [], deviceId: getDeviceId(), mutationId: crypto.randomUUID() });
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      await navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to create note.', 'error'); }
  }, [navigate, queryClient, toast]);
  const notes = notesQuery.data?.items ?? [];
  return <AppShell notes={notes} onNew={() => void createNote()} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })} onRealtimeEvent={handleRealtimeEvent} onRealtimeReconnect={recover}><div className="q-main-body"><div className="q-home-intro"><div><p className="q-eyebrow">A quiet place for useful knowledge</p><h2 className="q-display">Think clearly.<br /><span style={{ color: 'var(--teal)' }}>Keep the good parts.</span></h2><p className="q-subtitle">Markdown notes, reusable commands, and search that stays close to the work.</p></div><div className="q-home-actions"><Button size="lg" onClick={() => void createNote()}><Plus size={18} aria-hidden="true" />New note</Button></div></div><SearchPanel onOpenNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })} /><section className="q-card q-card-pad" style={{ marginTop: 24 }}><div className="q-section-heading"><h2>{syncing ? 'Refreshing your notes…' : 'Recently updated'}</h2><span className="q-small">{notes.length} notes</span></div>{notesQuery.isLoading ? <div className="q-empty">Loading your notes…</div> : notesQuery.error ? <div className="q-error">Unable to load notes. Check the local API.</div> : notes.length === 0 ? <div className="q-empty">Your first note can be a deployment recipe, a prompt, or a thought worth keeping.</div> : <div className="q-results">{notes.slice(0, 8).map((note) => <button className="q-note-item q-note-item-active" key={note.id} onClick={() => void navigate({ to: '/notes/$noteId', params: { noteId: note.id } })}><span className="q-note-item-heading"><span className="q-note-item-title">{note.title}</span><span className="q-note-item-time">{new Date(note.updatedAt).toLocaleDateString()}</span></span><span className="q-note-item-excerpt">{note.excerpt || 'Empty note'}</span></button>)}</div>}</section></div></AppShell>;
}
