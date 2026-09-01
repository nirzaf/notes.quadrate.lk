import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Note, RealtimeNoteEvent } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { threeWayMerge } from '@qnotes/sync';
import { api } from '../api';
import { getDeviceId } from '../indexed-db';
import { AppShell } from '../components/app-shell';
import { NotePreview } from '../components/note-preview';
import { NoteToolbar } from '../components/note-toolbar';
import { NotebookPicker } from '../components/notebook-picker';
import { SyncStatus } from '../components/sync-status';
import { ConflictResolver } from '../components/conflict-resolver';
import { AttachmentPanel } from '../components/attachment-panel';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/toast';
import { useNoteAutosave } from '../hooks/use-note-autosave';
import { useSyncRecovery } from '../hooks/use-sync-recovery';
import { formatUpdatedAt } from '../lib/utils';

const NoteEditor = lazy(() => import('../components/note-editor').then(({ NoteEditor: component }) => ({ default: component })));

function asNote(value: unknown): Note | null {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? value as Note : null;
}

export function NotePage(): JSX.Element {
  const { noteId } = useParams({ from: '/notes/$noteId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [conflict, setConflict] = useState<{ error: QNotesHttpError; remote: Note | null; remoteDeleted?: boolean } | null>(null);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [movingNotebook, setMovingNotebook] = useState(false);
  const noteQuery = useQuery({ queryKey: ['note', noteId], queryFn: () => api.getNote(noteId), enabled: Boolean(noteId) });
  const notesQuery = useQuery({ queryKey: ['notes'], queryFn: () => api.listNotes({ limit: 500 }) });
  const notebooksQuery = useQuery({ queryKey: ['notebooks'], queryFn: () => api.listNotebooks() });
  const attachmentsQuery = useQuery({ queryKey: ['attachments', noteId], queryFn: () => api.listAttachments(noteId), enabled: Boolean(noteQuery.data) });
  const onSaved = useCallback((saved: Note) => {
    queryClient.setQueryData(['note', saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    setConflict(null);
  }, [queryClient]);
  const onConflict = useCallback((error: QNotesHttpError) => {
    const details = error.details as { currentNote?: unknown } | undefined;
    setConflict({ error, remote: asNote(details?.currentNote) });
  }, []);
  const note = noteQuery.data;
  const autosave = useNoteAutosave({ note: note ?? { id: noteId, slug: '', title: '', contentMarkdown: '', contentPlain: '', tags: [], notebookId: null, version: 1, createdAt: '', updatedAt: '', deletedAt: null }, onSaved, onConflict });
  const { syncing, recover } = useSyncRecovery();
  const noteRef = useRef(note);
  const autosaveRef = useRef(autosave);
  const recoverRef = useRef(recover);
  noteRef.current = note;
  autosaveRef.current = autosave;
  recoverRef.current = recover;
  const event = useCallback(async (incoming: RealtimeNoteEvent) => {
    const currentNote = noteRef.current;
    const currentAutosave = autosaveRef.current;
    if (!currentNote || incoming.noteId !== currentNote.id) return;
    if (incoming.sourceDeviceId === getDeviceId()) return;
    if (incoming.action === 'deleted') {
      if (currentAutosave.dirty) {
        const remote = { ...currentNote, version: incoming.version, updatedAt: incoming.updatedAt, deletedAt: incoming.updatedAt };
        const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was deleted on another device.', crypto.randomUUID(), { currentVersion: incoming.version, currentNote: remote, deleted: true });
        setConflict({ error, remote, remoteDeleted: true });
      } else {
        await recoverRef.current();
      }
      return;
    }
    if (!currentAutosave.dirty && incoming.version <= currentNote.version) return;
    if (currentAutosave.dirty) {
      try {
        const remote = await api.getNote(currentNote.id);
        const merged = threeWayMerge(currentNote.contentMarkdown, currentAutosave.value, remote.contentMarkdown);
        if (merged.status === 'clean') {
          currentAutosave.adoptRemote(remote);
          queryClient.setQueryData(['note', currentNote.id], remote);
          if (merged.merged !== remote.contentMarkdown) {
            currentAutosave.change(merged.merged);
            await currentAutosave.flush();
          }
          await queryClient.invalidateQueries({ queryKey: ['notes'] });
        } else {
          const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', crypto.randomUUID(), { currentVersion: remote.version, currentNote: remote, conflicts: merged.conflicts });
          setConflict({ error, remote });
        }
      } catch {
        await recoverRef.current();
      }
      return;
    }
    await recoverRef.current();
  }, [queryClient]);
  const reconnect = useCallback(() => {
    if (!autosaveRef.current.dirty) void recoverRef.current();
  }, []);

  if (noteQuery.error) return <AppShell notes={notesQuery.data?.items ?? []}><div className="q-main-body"><div className="q-error">This note could not be opened.</div></div></AppShell>;
  if (noteQuery.isLoading || !note) return <AppShell notes={notesQuery.data?.items ?? []}><div className="q-main-body"><div className="q-empty">Loading note…</div></div></AppShell>;

  const noteForCopy = { ...note, contentMarkdown: autosave.value };
  const moveNotebook = async (notebookId: string | null) => {
    if (notebookId === note.notebookId || movingNotebook) return;
    setMovingNotebook(true);
    try {
      if (autosave.dirty || autosave.status === 'saving') await autosave.flush();
      const current = await queryClient.fetchQuery({ queryKey: ['note', note.id], queryFn: () => api.getNote(note.id) });
      if (notebookId === current.notebookId) return;
      const mutationId = crypto.randomUUID();
      const saved = await api.moveNoteToNotebook(current.id, { notebookId, expectedVersion: current.version, deviceId: getDeviceId(), mutationId });
      autosave.adoptRemote(saved);
      autosave.acknowledgeMutation(mutationId);
      queryClient.setQueryData(['note', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      toast(notebookId ? 'Note moved to notebook.' : 'Note moved to Unfiled.', 'success');
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Unable to move note.', 'error');
    } finally {
      setMovingNotebook(false);
    }
  };
  const updateDeletion = async (action: 'delete' | 'restore') => {
    try {
      const input = { expectedVersion: note.version, deviceId: getDeviceId(), mutationId: crypto.randomUUID() };
      const saved = action === 'delete' ? await api.deleteNote(note.id, input) : await api.restoreNote(note.id, input);
      autosave.adoptRemote(saved);
      autosave.acknowledgeMutation(input.mutationId);
      queryClient.setQueryData(['note', note.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      toast(action === 'delete' ? 'Note moved to the trash.' : 'Note restored.', 'success');
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to update note.', 'error'); }
  };
  const exportNote = async () => {
    try {
      const response = await api.exportNote(note.id);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${note.slug}.md`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch { toast('Unable to export note.', 'error'); }
  };
  const saveMine = () => {
    if (!conflict?.remote) return;
    autosave.adoptRemote(conflict.remote);
    autosave.change(autosave.value);
    setConflict(null);
    void autosave.flush();
  };
  const saveRemote = () => {
    if (!conflict?.remote) return;
    autosave.adoptRemote(conflict.remote);
    queryClient.setQueryData(['note', note.id], conflict.remote);
    setConflict(null);
  };
  const saveMerged = (markdown: string) => {
    if (!conflict?.remote) return;
    autosave.adoptRemote(conflict.remote);
    autosave.change(markdown);
    setConflict(null);
    void autosave.flush();
  };
  const saveAsNew = async () => {
    if (!conflict?.remoteDeleted) return;
    try {
      const recovered = await api.createNote({ title: `${note.title} (recovered)`, contentMarkdown: autosave.value, tags: note.tags, deviceId: getDeviceId(), mutationId: crypto.randomUUID() });
      if (conflict.remote) autosave.adoptRemote(conflict.remote);
      queryClient.setQueryData(['note', recovered.id], recovered);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      setConflict(null);
      toast('Draft saved as a new note.', 'success');
      await navigate({ to: '/notes/$noteId', params: { noteId: recovered.id } });
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Unable to recover the draft.', 'error');
    }
  };
  return <AppShell title={note.title} notes={notesQuery.data?.items ?? []} activeNoteId={note.id} onNew={() => void navigate({ to: '/' })} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })} onRealtimeEvent={event} onRealtimeReconnect={reconnect}><div className="q-main-body q-main-body-wide"><div className="q-editor-page"><section className="q-card q-editor-card"><div className="q-editor-meta"><div><h2 className="q-editor-title">{note.title}</h2><div className="q-small">{note.slug} · updated {formatUpdatedAt(note.updatedAt)}</div></div><SyncStatus status={syncing ? 'syncing' : autosave.status} /></div><div className="q-editor-controls"><div className="q-toolbar" aria-label="Note view"><Button variant={view === 'edit' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('edit')}>Edit</Button><Button variant={view === 'preview' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('preview')}>Preview</Button></div><NotebookPicker notebooks={notebooksQuery.data?.items ?? []} value={note.notebookId} disabled={movingNotebook || autosave.dirty || autosave.status === 'saving'} onChange={(notebookId) => void moveNotebook(notebookId)} /><div className="q-editor-actions"><NoteToolbar note={noteForCopy} onDelete={() => void updateDeletion('delete')} onRestore={() => void updateDeletion('restore')} onExport={() => void exportNote()} /></div></div>{view === 'edit' ? <Suspense fallback={<div className="q-empty">Loading editor…</div>}><NoteEditor value={autosave.value} onChange={autosave.change} /></Suspense> : <NotePreview markdown={autosave.value} />}<div className="q-editor-footer"><span className="q-small">Markdown is saved after 800ms of quiet.</span></div></section><aside className="q-panel-stack"><AttachmentPanel noteId={note.id} attachments={attachmentsQuery.data ?? []} onRefresh={() => void attachmentsQuery.refetch()} /><section className="q-card q-card-pad q-panel"><h3>Note details</h3><p>Version {note.version}. Your browser keeps only local drafts and recent snapshots in IndexedDB.</p><div className="q-tag-row">{note.tags.map((tag) => <span className="q-badge" key={tag}>{tag}</span>)}</div></section></aside></div></div><ConflictResolver open={Boolean(conflict)} baseMarkdown={note.contentMarkdown} localMarkdown={autosave.value} remoteNote={conflict?.remote ?? null} remoteDeleted={conflict?.remoteDeleted ?? false} error={conflict?.error} onUseMine={saveMine} onUseRemote={saveRemote} onSaveMerged={saveMerged} onSaveAsNew={() => void saveAsNew()} onCancel={() => setConflict(null)} /></AppShell>;
}
