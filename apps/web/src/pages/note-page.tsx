import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_TITLE_LENGTH, type Note, type RealtimeNoteEvent } from '@qnotes/shared';
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
import { NoteMetadataEditor } from '../components/note-metadata-editor';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { useAuth } from '../auth-context';
import { useNoteAutosave } from '../hooks/use-note-autosave';
import { useCreateNote } from '../hooks/use-create-note';
import { useSyncRecovery } from '../hooks/use-sync-recovery';
import { formatUpdatedAt } from '../lib/utils';
import { noteQueryKeys, refreshNoteViews, type WorkspaceQueryKeys } from '../note-query-keys';
import { withoutSearchMatch, type AppSearchParams } from '../navigation-context';

const NoteEditor = lazy(() => import('../components/note-editor').then(({ NoteEditor: component }) => ({ default: component })));

function asNote(value: unknown): Note | null {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? value as Note : null;
}

function tagsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function NoteUnavailable({ error = false, onRetry }: { error?: boolean; onRetry?: () => void }): JSX.Element {
  return <main className="q-auth-page"><section className="q-card q-auth-card" role={error ? 'alert' : undefined}><p className="q-eyebrow">Note</p><h1 className="q-display" style={{ fontSize: '2.8rem' }}>{error ? 'This note could not be opened.' : 'Loading note…'}</h1><p className="q-subtitle">{error ? 'It may have been deleted, moved, or you may no longer have access to it.' : 'Opening the current version of this note.'}</p><div className="q-dialog-actions">{onRetry && <Button type="button" onClick={onRetry}>Retry</Button>}<Link className="q-button q-button-primary" to="/">Go to Notes</Link></div></section></main>;
}

class EditorErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // The visible recovery action below is intentionally the only response to a failed editor chunk.
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="q-error" role="alert">The editor could not be loaded. Your local draft is preserved. <button className="q-button q-button-ghost q-button-sm" type="button" onClick={() => window.location.reload()}>Retry editor</button></div>;
  }
}

export function NotePage(): JSX.Element {
  const { noteId } = useParams({ from: '/notes/$noteId' });
  const search = useSearch({ from: '/notes/$noteId' });
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const noteQuery = useQuery({
    queryKey: queryKeys.note(noteId),
    queryFn: ({ signal }) => api.getNote(noteId, { includeDeleted: true, signal }),
    enabled: Boolean(session && noteId),
  });

  if (noteQuery.isPending) return <NoteUnavailable />;
  if (noteQuery.error || !noteQuery.data) return <NoteUnavailable error onRetry={() => void noteQuery.refetch()} />;
  return <LoadedNoteSession key={`${userId}:${noteQuery.data.id}`} note={noteQuery.data} userId={userId} search={search} queryKeys={queryKeys} />;
}

interface LoadedNoteSessionProps {
  note: Note;
  userId: string;
  search: AppSearchParams;
  queryKeys: WorkspaceQueryKeys;
}

function LoadedNoteSession({ note, userId, search, queryKeys }: LoadedNoteSessionProps): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [conflict, setConflict] = useState<{ error: QNotesHttpError; remote: Note | null; remoteDeleted?: boolean } | null>(null);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [movingNotebook, setMovingNotebook] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const notesQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }) });
  const notebooksQuery = useQuery({ queryKey: queryKeys.notebooks, queryFn: ({ signal }) => api.listNotebooks({ signal }) });
  const attachmentsQuery = useQuery({ queryKey: queryKeys.attachments(note.id), queryFn: ({ signal }) => api.listAttachments(note.id, { signal }) });
  const searchContextQuery = useQuery({ queryKey: search.documentId ? queryKeys.searchContext(search.documentId) : ['qnotes', userId, 'search-context', 'none'], queryFn: ({ signal }) => api.readNoteContext(search.documentId!, { before: 1, after: 1, maxTokens: 1800, signal }), enabled: Boolean(search.documentId), staleTime: 30_000 });
  const onSaved = useCallback((saved: Note) => {
    queryClient.setQueryData(queryKeys.note(saved.id), saved);
    void refreshNoteViews(queryClient, userId, saved.id).catch(() => undefined);
  }, [queryClient, queryKeys, userId]);
  const onConflict = useCallback((error: QNotesHttpError) => {
    const details = error.details as { currentNote?: unknown } | undefined;
    setConflict({ error, remote: asNote(details?.currentNote), remoteDeleted: Boolean(details && 'deleted' in details && details.deleted) });
  }, []);
  const autosave = useNoteAutosave({ note, onSaved, onConflict, readOnly: Boolean(note.deletedAt) });
  const { create } = useCreateNote({
    notebookId: note.notebookId,
    onCreated: async (created) => { await queryClient.invalidateQueries({ queryKey: queryKeys.all }); await navigate({ to: '/notes/$noteId', params: { noteId: created.id } }); },
    onError: (error) => toast(error instanceof Error ? error.message : 'Unable to create note. Try again.', 'error'),
  });
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
    if (incoming.noteId !== currentNote.id) {
      await refreshNoteViews(queryClient, userId, incoming.noteId);
      await recoverRef.current();
      return;
    }
    if (incoming.sourceDeviceId === getDeviceId()) {
      await refreshNoteViews(queryClient, userId, incoming.noteId);
      return;
    }
    if (incoming.action === 'deleted') {
      await refreshNoteViews(queryClient, userId, incoming.noteId);
      if (currentAutosave.dirty) {
        const remote = { ...currentNote, version: incoming.version, updatedAt: incoming.updatedAt, deletedAt: incoming.updatedAt };
        const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was deleted on another device.', crypto.randomUUID(), { currentVersion: incoming.version, currentNote: remote, deleted: true });
        setConflict({ error, remote, remoteDeleted: true });
      } else await recoverRef.current();
      return;
    }
    if (!currentAutosave.dirty && incoming.version <= currentNote.version) {
      await refreshNoteViews(queryClient, userId, incoming.noteId);
      return;
    }
    if (currentAutosave.dirty) {
      try {
        const remote = await api.getNote(currentNote.id);
        const merged = threeWayMerge(currentNote.contentMarkdown, currentAutosave.value, remote.contentMarkdown);
        const localMetadataChanged = currentAutosave.title !== currentNote.title || !tagsEqual(currentAutosave.tags, currentNote.tags);
        const remoteMetadataChanged = remote.title !== currentNote.title || !tagsEqual(remote.tags, currentNote.tags);
        const metadataConflict = localMetadataChanged && remoteMetadataChanged && (currentAutosave.title !== remote.title || !tagsEqual(currentAutosave.tags, remote.tags));
        if (merged.status === 'clean' && !metadataConflict) {
          const localTitle = currentAutosave.title; const localTags = [...currentAutosave.tags];
          currentAutosave.adoptRemote(remote);
          queryClient.setQueryData(queryKeys.note(currentNote.id), remote);
          if (localMetadataChanged) currentAutosave.changeMetadata({ title: localTitle, tags: localTags });
          if (merged.merged !== remote.contentMarkdown) currentAutosave.change(merged.merged);
          if (localMetadataChanged || merged.merged !== remote.contentMarkdown) await currentAutosave.flush();
          await refreshNoteViews(queryClient, userId, currentNote.id);
        } else {
          const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', crypto.randomUUID(), { currentVersion: remote.version, currentNote: remote, conflicts: merged.conflicts });
          setConflict({ error, remote });
        }
      } catch { await recoverRef.current(); }
      return;
    }
    await recoverRef.current();
  }, [queryClient, queryKeys, userId]);
  const reconnect = useCallback(() => { if (!autosaveRef.current.dirty) void recoverRef.current().catch(() => undefined); }, []);
  const blocker = useBlocker({
    shouldBlockFn: async () => {
      if (!autosave.dirty && autosave.status !== 'saving' && autosave.status !== 'pending') return false;
      try { await autosave.flush(); return false; } catch { return true; }
    },
    enableBeforeUnload: () => autosave.dirty || autosave.status === 'saving' || autosave.status === 'pending',
    withResolver: true,
  });
  useEffect(() => { if (blocker.status === 'blocked' && autosave.status === 'saved') blocker.proceed(); }, [autosave.status, blocker]);

  const moveNotebook = async (notebookId: string | null) => {
    if (notebookId === note.notebookId || movingNotebook) return;
    setMovingNotebook(true);
    try {
      if (autosave.dirty || autosave.status === 'saving' || autosave.status === 'pending') await autosave.flush();
      const current = await queryClient.fetchQuery({ queryKey: queryKeys.note(note.id), queryFn: ({ signal }) => api.getNote(note.id, { includeDeleted: true, signal }) });
      if (notebookId === current.notebookId) return;
      const mutationId = crypto.randomUUID();
      const saved = await api.moveNoteToNotebook(current.id, { notebookId, expectedVersion: current.version, deviceId: getDeviceId(), mutationId });
      autosave.adoptRemote(saved); autosave.acknowledgeMutation(mutationId); queryClient.setQueryData(queryKeys.note(saved.id), saved);
      await refreshNoteViews(queryClient, userId, saved.id); toast(notebookId ? 'Note moved to notebook.' : 'Note moved to Unfiled.', 'success');
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to move note.', 'error'); }
    finally { setMovingNotebook(false); }
  };
  const updateDeletion = async (action: 'delete' | 'restore', force = false) => {
    try {
      if (action === 'delete' && !force && (autosave.dirty || autosave.status === 'saving' || autosave.status === 'pending')) {
        if (autosave.status === 'validation-error' || autosave.status === 'network-error' || autosave.status === 'storage-error' || autosave.status === 'conflict' || autosave.status === 'offline' || autosave.status === 'draft' || autosave.status === 'error') { setDeleteBlocked(true); return; }
        try { await autosave.flush(); } catch { setDeleteBlocked(true); return; }
      }
      const current = await api.getNote(note.id, { includeDeleted: true });
      const input = { expectedVersion: current.version, deviceId: getDeviceId(), mutationId: crypto.randomUUID() };
      const saved = action === 'delete' ? await api.deleteNote(note.id, input) : await api.restoreNote(note.id, input);
      if (action === 'restore' && autosave.dirty) {
        const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was restored. Review your saved draft before saving it.', crypto.randomUUID(), { currentVersion: saved.version, currentNote: saved });
        setConflict({ error, remote: saved });
      } else if (action === 'delete' && !force) autosave.adoptRemote(saved);
      autosave.acknowledgeMutation(input.mutationId); queryClient.setQueryData(queryKeys.note(note.id), saved);
      await refreshNoteViews(queryClient, userId, note.id); setDeleteBlocked(false); toast(action === 'delete' ? 'Note moved to the trash.' : 'Note restored.', 'success');
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to update note.', 'error'); }
  };
  const exportNote = async () => {
    let url: string | null = null;
    try { url = URL.createObjectURL(new Blob([autosave.value], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${note.slug}.md`; link.click(); }
    catch { toast('Unable to export the current draft.', 'error'); }
    finally { if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 0); }
  };
  const openContextAttachment = async () => {
    const attachmentId = searchContextQuery.data?.attachmentId;
    if (!attachmentId) return;
    try { const result = await api.getAttachmentDownloadUrl(attachmentId); const opened = window.open(result.signedUrl, '_blank', 'noopener,noreferrer'); if (!opened) toast('Your browser blocked the attachment window. Return to Search and use the file action there.', 'info'); }
    catch { toast('Unable to open this private attachment.', 'error'); }
  };
  const saveMine = () => {
    if (!conflict?.remote) return;
    const localMarkdown = autosave.value; const localTitle = autosave.title; const localTags = [...autosave.tags];
    autosave.adoptRemote(conflict.remote); autosave.changeMetadata({ title: localTitle, tags: localTags }); autosave.change(localMarkdown); setConflict(null); void autosave.flush().catch(() => undefined);
  };
  const saveRemote = () => { if (!conflict?.remote) return; autosave.adoptRemote(conflict.remote); queryClient.setQueryData(queryKeys.note(note.id), conflict.remote); setConflict(null); };
  const saveMerged = (markdown: string) => {
    if (!conflict?.remote) return;
    const localTitle = autosave.title; const localTags = [...autosave.tags];
    autosave.adoptRemote(conflict.remote); autosave.changeMetadata({ title: localTitle, tags: localTags }); autosave.change(markdown); setConflict(null); void autosave.flush().catch(() => undefined);
  };
  const saveAsNew = async () => {
    if (!conflict?.remoteDeleted) return;
    try {
      const recoveredTitle = `${autosave.title || 'Untitled note'} (recovered)`.slice(0, MAX_TITLE_LENGTH);
      const recovered = await api.createNote({ title: recoveredTitle, contentMarkdown: autosave.value, tags: autosave.tags, notebookId: note.notebookId, deviceId: getDeviceId(), mutationId: crypto.randomUUID() });
      if (conflict.remote) autosave.adoptRemote(conflict.remote);
      queryClient.setQueryData(queryKeys.note(recovered.id), recovered); await refreshNoteViews(queryClient, userId, recovered.id); setConflict(null); toast('Draft saved as a new note.', 'success'); await navigate({ to: '/notes/$noteId', params: { noteId: recovered.id } });
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to recover the draft.', 'error'); }
  };
  const leaveWithDraft = async () => { try { await autosave.preserveDraft(); blocker.proceed?.(); } catch { /* status and error are shown by the editor */ } };
  const noteForCopy = { ...note, title: autosave.title, tags: autosave.tags, contentMarkdown: autosave.value };
  return <AppShell title={autosave.title || 'Untitled note'} notes={notesQuery.data?.items ?? []} activeNoteId={note.id} onNew={() => void create()} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id }, search: withoutSearchMatch(search) })} onRealtimeEvent={event} onRealtimeReconnect={reconnect}>
    <div className="q-main-body q-main-body-wide"><Link to="/" search={withoutSearchMatch(search)} className="q-note-back">← Back to {search.q ? 'search results' : 'notes'}</Link>
      {searchContextQuery.data && <section className="q-search-context" aria-label="Matching search context"><div className="q-search-context-heading"><div><span className="q-eyebrow">Opened from search</span><strong>{searchContextQuery.data.headingPath ?? searchContextQuery.data.sourceTitle ?? 'Matching section'}</strong><span className="q-small">{searchContextQuery.data.sourceType === 'attachment_chunk' ? `Attachment excerpt${searchContextQuery.data.pageNumber ? ` · page ${searchContextQuery.data.pageNumber}` : ''}` : 'Authoritative current context'}{note.version !== searchContextQuery.data.noteVersion ? ' · The note changed since this result was indexed.' : ''}</span></div>{searchContextQuery.data.attachmentId && <Button type="button" variant="outline" size="sm" onClick={() => void openContextAttachment()}>Open attachment</Button>}</div><p>{[...searchContextQuery.data.previous, searchContextQuery.data.content, ...searchContextQuery.data.next].join('\n\n')}</p></section>}
      <div className="q-editor-page"><section className="q-card q-editor-card">{note.deletedAt ? <div className="q-deleted-banner" role="status">This note is in Trash. Restore it to continue editing.</div> : null}
        <div className="q-editor-meta"><div className="q-editor-metadata"><NoteMetadataEditor title={autosave.title} tags={autosave.tags} disabled={Boolean(note.deletedAt)} onTitleChange={(nextTitle) => autosave.changeMetadata({ title: nextTitle })} onTitleBlur={() => autosave.changeMetadata({ title: autosave.title.trim() || 'Untitled note' })} onTagsChange={(nextTags) => autosave.changeMetadata({ tags: nextTags })} /><div className="q-small">{note.slug} · updated {formatUpdatedAt(note.updatedAt)}</div>{autosave.errorMessage ? <div className="q-error q-editor-save-error" role="alert">{autosave.errorMessage}</div> : null}</div><SyncStatus status={syncing ? 'syncing' : autosave.status} savedAt={autosave.savedAt} onRetry={autosave.retry} /></div>
        <div className="q-editor-controls"><div className="q-toolbar" aria-label="Note view"><Button variant={view === 'edit' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('edit')}>Edit</Button><Button variant={view === 'preview' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('preview')}>Preview</Button></div><NotebookPicker notebooks={notebooksQuery.data?.items ?? []} value={note.notebookId} disabled={Boolean(note.deletedAt) || movingNotebook || autosave.dirty || autosave.status === 'saving' || autosave.status === 'pending'} onChange={(notebookId) => void moveNotebook(notebookId)} /><div className="q-editor-actions"><NoteToolbar note={noteForCopy} onDelete={() => void updateDeletion('delete')} onRestore={() => void updateDeletion('restore')} onExport={() => void exportNote()} /></div></div>
        {view === 'edit' ? <EditorErrorBoundary><Suspense fallback={<div className="q-empty">Loading editor…</div>}><NoteEditor key={note.id} value={autosave.value} onChange={autosave.change} readOnly={Boolean(note.deletedAt)} /></Suspense></EditorErrorBoundary> : <NotePreview markdown={autosave.value} />}
        <div className="q-editor-footer"><span className="q-small">{note.deletedAt ? 'Read-only note in Trash.' : 'Markdown is saved after 800ms of quiet.'}</span></div>
      </section>{!note.deletedAt ? <aside className="q-panel-stack"><AttachmentPanel noteId={note.id} attachments={attachmentsQuery.data ?? []} onRefresh={() => attachmentsQuery.refetch()} /></aside> : null}</div>
    </div>
    <ConflictResolver open={Boolean(conflict)} baseMarkdown={note.contentMarkdown} localMarkdown={autosave.value} remoteNote={conflict?.remote ?? null} remoteDeleted={conflict?.remoteDeleted ?? false} error={conflict?.error} onUseMine={saveMine} onUseRemote={saveRemote} onSaveMerged={saveMerged} onSaveAsNew={() => void saveAsNew()} onCancel={() => setConflict(null)} />
    <Dialog open={blocker.status === 'blocked'} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}><DialogContent><DialogHeader><DialogTitle>Save is still pending</DialogTitle><DialogDescription>The server did not confirm the latest edit. Your local draft remains available. Retry, stay here, or leave only after the draft is durably stored on this account.</DialogDescription></DialogHeader><div className="q-dialog-actions"><Button variant="outline" onClick={() => blocker.reset?.()}>Stay and edit</Button><Button variant="secondary" onClick={() => { blocker.reset?.(); autosave.retry(); }}>Retry save</Button><Button onClick={() => void leaveWithDraft()}>Leave with draft</Button></div></DialogContent></Dialog>
    <Dialog open={deleteBlocked} onOpenChange={setDeleteBlocked}><DialogContent><DialogHeader><DialogTitle>Save is blocked</DialogTitle><DialogDescription>Your local draft is retained, but the server rejected or could not receive the latest changes. Keep editing and retry, or move the current server version to Trash while keeping this draft for recovery.</DialogDescription></DialogHeader><div className="q-dialog-actions"><Button variant="outline" onClick={() => setDeleteBlocked(false)}>Keep note</Button><Button variant="danger" onClick={() => void updateDeletion('delete', true)}>Delete anyway</Button></div></DialogContent></Dialog>
  </AppShell>;
}
