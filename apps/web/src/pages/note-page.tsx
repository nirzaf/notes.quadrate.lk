import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_TITLE_LENGTH, type Note, type RealtimeNoteEvent } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { reconcileDraft, type DraftMetadataConflict, type DraftValues } from '@qnotes/sync';
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
import { PublicShareDialog } from '../components/public-share-dialog';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { useAuth } from '../auth-context';
import { useNoteAutosave } from '../hooks/use-note-autosave';
import { useCreateNote } from '../hooks/use-create-note';
import { useSyncRecovery } from '../hooks/use-sync-recovery';
import { shouldSkipAcknowledgedRealtimeEvent } from '../realtime-policy';
import { formatUpdatedAt } from '../lib/utils';
import { consumeEditorFocus, requestEditorFocus } from '../lib/editor-focus';
import { captureFullPageScreenshot, screenshotFile, waitForScreenshotLayout } from '../lib/screenshot';
import { noteQueryKeys, refreshNoteCollections, refreshNoteViews, type WorkspaceQueryKeys } from '../note-query-keys';
import { withoutSearchMatch, type AppSearchParams } from '../navigation-context';

const NoteEditor = lazy(() => import('../components/note-editor').then(({ NoteEditor: component }) => ({ default: component })));

function asNote(value: unknown): Note | null {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? value as Note : null;
}

function tagsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function valuesFromNote(note: Note): DraftValues {
  return { markdown: note.contentMarkdown, title: note.title, tags: [...note.tags], notebookId: note.notebookId };
}

interface NoteConflict {
  error: QNotesHttpError;
  remote: Note | null;
  remoteDeleted?: boolean;
  baseVersion?: number;
  baseValues?: DraftValues;
  baseMarkdown?: string;
  localValues?: DraftValues;
  metadataConflicts?: DraftMetadataConflict[];
  reconciledValues?: DraftValues;
}

function conflictMetadata(conflict: NoteConflict, current: DraftValues): Pick<DraftValues, 'title' | 'tags' | 'notebookId'> {
  const merged = conflict.reconciledValues;
  const local = conflict.localValues;
  if (!merged || !local) return { title: current.title, tags: [...current.tags], notebookId: current.notebookId };
  return {
    title: current.title === local.title ? merged.title : current.title,
    tags: tagsEqual(current.tags, local.tags) ? [...merged.tags] : [...current.tags],
    notebookId: current.notebookId === local.notebookId ? merged.notebookId : current.notebookId,
  };
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
  const [conflict, setConflict] = useState<NoteConflict | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [focusEditor, setFocusEditor] = useState(() => consumeEditorFocus(note.id));
  const [view, setView] = useState<'edit' | 'preview'>(() => (focusEditor ? 'edit' : 'preview'));
  const [movingNotebook, setMovingNotebook] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [resolvingRemote, setResolvingRemote] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const noteRef = useRef(note);
  const notesQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }) });
  const notebooksQuery = useQuery({ queryKey: queryKeys.notebooks, queryFn: ({ signal }) => api.listNotebooks({ signal }) });
  const attachmentsQuery = useQuery({ queryKey: queryKeys.attachments(note.id), queryFn: ({ signal }) => api.listAttachments(note.id, { signal }) });
  const shareQuery = useQuery({ queryKey: queryKeys.share(note.id), queryFn: ({ signal }) => api.getPublicShare(note.id, { signal }), enabled: !note.deletedAt });
  const searchContextQuery = useQuery({ queryKey: search.documentId ? queryKeys.searchContext(search.documentId) : ['qnotes', userId, 'search-context', 'none'], queryFn: ({ signal }) => api.readNoteContext(search.documentId!, { before: 1, after: 1, maxTokens: 1800, signal }), enabled: Boolean(search.documentId), staleTime: 30_000 });
  const onSaved = useCallback((saved: Note) => {
    queryClient.setQueryData(queryKeys.note(saved.id), saved);
    void refreshNoteViews(queryClient, userId, saved.id).catch(() => undefined);
  }, [queryClient, queryKeys, userId]);
  const onConflict = useCallback((error: QNotesHttpError) => {
    const details = error.details as { currentNote?: unknown; draftBaseVersion?: unknown; draftBaseTitle?: unknown; draftBaseTags?: unknown; draftBaseNotebookId?: unknown; baseMarkdown?: unknown; localValues?: unknown; metadataConflicts?: unknown; reconciledValues?: unknown } | undefined;
    const metadataConflicts = Array.isArray(details?.metadataConflicts) ? details.metadataConflicts as DraftMetadataConflict[] : [];
    const localValues = details?.localValues && typeof details.localValues === 'object' ? details.localValues as DraftValues : undefined;
    const reconciledValues = details?.reconciledValues && typeof details.reconciledValues === 'object' ? details.reconciledValues as DraftValues : undefined;
    const baseNote = noteRef.current;
    const baseValues: DraftValues = {
      markdown: typeof details?.baseMarkdown === 'string' ? details.baseMarkdown : baseNote.contentMarkdown,
      title: typeof details?.draftBaseTitle === 'string' ? details.draftBaseTitle : baseNote.title,
      tags: Array.isArray(details?.draftBaseTags) && details.draftBaseTags.every((tag): tag is string => typeof tag === 'string') ? [...details.draftBaseTags] : [...baseNote.tags],
      notebookId: details && Object.hasOwn(details, 'draftBaseNotebookId') && (details.draftBaseNotebookId === null || typeof details.draftBaseNotebookId === 'string') ? details.draftBaseNotebookId : baseNote.notebookId,
    };
    setConflict({ error, remote: asNote(details?.currentNote), baseVersion: typeof details?.draftBaseVersion === 'number' ? details.draftBaseVersion : baseNote.version, baseValues, remoteDeleted: Boolean(details && 'deleted' in details && details.deleted), ...(typeof details?.baseMarkdown === 'string' ? { baseMarkdown: details.baseMarkdown } : {}), ...(localValues ? { localValues } : {}), ...(metadataConflicts.length ? { metadataConflicts } : {}), ...(reconciledValues ? { reconciledValues } : {}) });
  }, []);
  useEffect(() => { if (conflict) setConflictOpen(true); }, [conflict]);
  const autosave = useNoteAutosave({ note, onSaved, onConflict, readOnly: Boolean(note.deletedAt) });
  const flushBeforeShare = useCallback(async (): Promise<Note> => {
    if (!autosave.dirty && autosave.status !== 'saving' && autosave.status !== 'pending') return noteRef.current;
    try {
      return await autosave.flush();
    } catch {
      throw new Error('Save the note successfully before creating a public link. Public links show only saved content.');
    }
  }, [autosave, noteRef]);
  const { create } = useCreateNote({
    notebookId: note.notebookId,
    onCreated: async (created) => { await refreshNoteCollections(queryClient, userId); requestEditorFocus(created.id); await navigate({ to: '/notes/$noteId', params: { noteId: created.id } }); },
    onError: (error) => toast(error instanceof Error ? error.message : 'Unable to create note. Try again.', 'error'),
  });
  const { syncing, recover } = useSyncRecovery();
  const autosaveRef = useRef(autosave);
  const recoverRef = useRef(recover);
  const conflictRef = useRef(conflict);
  const resolvingRemoteRef = useRef(false);
  noteRef.current = note;
  autosaveRef.current = autosave;
  recoverRef.current = recover;
  conflictRef.current = conflict;

  const event = useCallback(async (incoming: RealtimeNoteEvent) => {
    const currentNote = noteRef.current;
    const currentAutosave = autosaveRef.current;
    if (incoming.noteId === currentNote.id && shouldSkipAcknowledgedRealtimeEvent(incoming, getDeviceId(), currentAutosave.isMutationAcknowledged)) return;
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
        currentAutosave.blockAutosave();
        setConflict({ error, remote, remoteDeleted: true, baseVersion: currentNote.version, baseValues: valuesFromNote(currentNote), baseMarkdown: currentNote.contentMarkdown, localValues: { markdown: currentAutosave.value, title: currentAutosave.title, tags: [...currentAutosave.tags], notebookId: currentAutosave.notebookId } });
      } else await recoverRef.current();
      return;
    }
    if (!currentAutosave.dirty && incoming.version <= currentNote.version) {
      await refreshNoteViews(queryClient, userId, incoming.noteId);
      return;
    }
    if (currentAutosave.status === 'conflict') {
      try {
        const remote = await api.getNote(currentNote.id, { includeDeleted: true });
        const retained = conflictRef.current;
        if (!retained) return;
        const base = retained.baseValues ?? valuesFromNote(currentNote);
        const reconciled = reconcileDraft({
          noteId: currentNote.id,
          baseVersion: retained.baseVersion ?? currentNote.version,
          baseMarkdown: retained.baseMarkdown ?? base.markdown,
          localMarkdown: currentAutosave.value,
          baseTitle: base.title,
          localTitle: currentAutosave.title,
          baseTags: [...base.tags],
          localTags: [...currentAutosave.tags],
          baseNotebookId: base.notebookId,
          localNotebookId: currentAutosave.notebookId,
          updatedAt: currentNote.updatedAt,
        }, remote);
        const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', retained.error.message, crypto.randomUUID(), {
          ...(retained.error.details && typeof retained.error.details === 'object' ? retained.error.details as Record<string, unknown> : {}),
          currentVersion: remote.version,
          currentNote: remote,
          conflicts: reconciled.conflicts,
          metadataConflicts: reconciled.metadataConflicts,
          reconciledValues: reconciled.values,
        });
        setConflict((current) => current ? {
          ...current,
          error,
          remote,
          remoteDeleted: Boolean(remote.deletedAt),
          metadataConflicts: reconciled.metadataConflicts,
          reconciledValues: reconciled.values,
        } : current);
      } catch { /* Keep the retained conflict until the user retries. */ }
      return;
    }
    if (currentAutosave.dirty) {
      try {
        const remote = await api.getNote(currentNote.id);
        const merged = reconcileDraft({
          noteId: currentNote.id,
          baseVersion: currentNote.version,
          baseMarkdown: currentNote.contentMarkdown,
          localMarkdown: currentAutosave.value,
          baseTitle: currentNote.title,
          localTitle: currentAutosave.title,
          baseTags: [...currentNote.tags],
          localTags: [...currentAutosave.tags],
          baseNotebookId: currentNote.notebookId,
          localNotebookId: currentAutosave.notebookId,
          updatedAt: currentNote.updatedAt,
        }, remote);
        if (merged.status === 'clean') {
          currentAutosave.adoptRemote(remote);
          queryClient.setQueryData(queryKeys.note(currentNote.id), remote);
          const metadataChanged = merged.values.title !== remote.title || !tagsEqual(merged.values.tags, remote.tags);
          const notebookChanged = merged.values.notebookId !== remote.notebookId;
          const bodyChanged = merged.values.markdown !== remote.contentMarkdown;
          if (metadataChanged) currentAutosave.changeMetadata({ title: merged.values.title, tags: merged.values.tags });
          if (notebookChanged) currentAutosave.changeNotebook(merged.values.notebookId);
          if (bodyChanged) currentAutosave.change(merged.values.markdown);
          if (metadataChanged || notebookChanged || bodyChanged) await currentAutosave.flush();
          await refreshNoteViews(queryClient, userId, currentNote.id);
        } else {
          const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', 'The note was changed on another device.', crypto.randomUUID(), { currentVersion: remote.version, currentNote: remote, conflicts: merged.conflicts, metadataConflicts: merged.metadataConflicts, reconciledValues: merged.values, baseMarkdown: currentNote.contentMarkdown });
          currentAutosave.blockAutosave();
          setConflict({ error, remote, baseVersion: currentNote.version, baseValues: valuesFromNote(currentNote), baseMarkdown: currentNote.contentMarkdown, localValues: { markdown: currentAutosave.value, title: currentAutosave.title, tags: [...currentAutosave.tags], notebookId: currentAutosave.notebookId }, ...(merged.metadataConflicts.length ? { metadataConflicts: merged.metadataConflicts } : {}), reconciledValues: merged.values });
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
        autosave.blockAutosave();
        setConflict({ error, remote: saved, baseVersion: current.version, baseValues: valuesFromNote(current), baseMarkdown: current.contentMarkdown, localValues: { markdown: autosave.value, title: autosave.title, tags: [...autosave.tags], notebookId: autosave.notebookId } });
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
    const localMarkdown = autosave.value; const localTitle = autosave.title; const localTags = [...autosave.tags]; const localNotebookId = autosave.notebookId;
    autosave.adoptRemote(conflict.remote); autosave.changeMetadata({ title: localTitle, tags: localTags }); autosave.changeNotebook(localNotebookId); autosave.change(localMarkdown); setConflict(null); setConflictOpen(false); void autosave.flush().catch(() => undefined);
  };
  const saveRemote = () => {
    if (!conflict?.remote || resolvingRemoteRef.current) return;
    resolvingRemoteRef.current = true;
    setResolvingRemote(true);
    void api.getNote(note.id, { includeDeleted: true }).then(async (remote) => {
      if (remote.deletedAt) {
        queryClient.setQueryData(queryKeys.note(note.id), remote);
        await refreshNoteViews(queryClient, userId, note.id).catch(() => undefined);
        setConflict((current) => current ? { ...current, remote, remoteDeleted: true } : current);
        return;
      }
      autosave.adoptRemote(remote);
      queryClient.setQueryData(queryKeys.note(note.id), remote);
      setConflict(null);
      setConflictOpen(false);
    }).catch(() => toast('The latest note version could not be loaded. Review the conflict again and retry.', 'error')).finally(() => {
      resolvingRemoteRef.current = false;
      setResolvingRemote(false);
    });
  };
  const saveMerged = (markdown: string) => {
    if (!conflict?.remote) return;
    const mergedMetadata = conflictMetadata(conflict, { markdown: autosave.value, title: autosave.title, tags: [...autosave.tags], notebookId: autosave.notebookId });
    const localTitle = mergedMetadata.title; const localTags = mergedMetadata.tags; const localNotebookId = mergedMetadata.notebookId;
    autosave.adoptRemote(conflict.remote); autosave.changeMetadata({ title: localTitle, tags: localTags }); autosave.changeNotebook(localNotebookId); autosave.change(markdown); setConflict(null); setConflictOpen(false); void autosave.flush().catch(() => undefined);
  };
  const saveAsNew = async () => {
    if (!conflict?.remoteDeleted) return;
    try {
      const recoveredTitle = `${autosave.title || 'Untitled note'} (recovered)`.slice(0, MAX_TITLE_LENGTH);
      const recovered = await api.createNote({ title: recoveredTitle, contentMarkdown: autosave.value, tags: autosave.tags, notebookId: autosave.notebookId, deviceId: getDeviceId(), mutationId: crypto.randomUUID() });
      if (conflict.remote) autosave.adoptRemote(conflict.remote);
      queryClient.setQueryData(queryKeys.note(recovered.id), recovered); await refreshNoteViews(queryClient, userId, recovered.id); setConflict(null); setConflictOpen(false); toast('Draft saved as a new note.', 'success'); await navigate({ to: '/notes/$noteId', params: { noteId: recovered.id } });
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to recover the draft.', 'error'); }
  };
  const leaveWithDraft = async () => { try { await autosave.preserveDraft(); blocker.proceed?.(); } catch { /* status and error are shown by the editor */ } };
  const captureEntirePage = useCallback(async () => {
    const target = document.querySelector<HTMLElement>('[data-screenshot-capture-target]');
    if (!target) throw new Error('The current page could not be captured.');
    const previousView = view;
    const previousScrollTop = target.scrollTop;
    const previousScrollLeft = target.scrollLeft;
    try {
      if (previousView !== 'preview') setView('preview');
      await waitForScreenshotLayout();
      return screenshotFile(await captureFullPageScreenshot(target), 'full-page');
    } finally {
      if (previousView !== 'preview') setView(previousView);
      await waitForScreenshotLayout();
      target.scrollTop = previousScrollTop;
      target.scrollLeft = previousScrollLeft;
    }
  }, [view]);
  const enterEdit = () => {
    setFocusEditor(true);
    setView('edit');
  };
  const noteForCopy = { ...note, title: autosave.title, tags: autosave.tags, contentMarkdown: autosave.value };
  return <AppShell title={autosave.title || 'Untitled note'} notes={notesQuery.data?.items ?? []} activeNoteId={note.id} mobileBack mobileBackLabel={search.q ? 'Search' : 'Notes'} onNew={() => void create()} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id }, search: withoutSearchMatch(search) })} onRealtimeEvent={event} onRealtimeReconnect={reconnect}>
    <div className="q-main-body q-main-body-wide"><Link to="/" search={withoutSearchMatch(search)} className="q-note-back q-note-back-body">← Back to {search.q ? 'search results' : 'notes'}</Link>
      {searchContextQuery.data && <section className="q-search-context" aria-label="Matching search context"><div className="q-search-context-heading"><div><span className="q-eyebrow">Opened from search</span><strong>{searchContextQuery.data.headingPath ?? searchContextQuery.data.sourceTitle ?? 'Matching section'}</strong><span className="q-small">{searchContextQuery.data.sourceType === 'attachment_chunk' ? `Attachment excerpt${searchContextQuery.data.pageNumber ? ` · page ${searchContextQuery.data.pageNumber}` : ''}` : 'Authoritative current context'}{note.version !== searchContextQuery.data.noteVersion ? ' · The note changed since this result was indexed.' : ''}</span></div>{searchContextQuery.data.attachmentId && <Button type="button" variant="outline" size="sm" onClick={() => void openContextAttachment()}>Open attachment</Button>}</div><p>{[...searchContextQuery.data.previous, searchContextQuery.data.content, ...searchContextQuery.data.next].join('\n\n')}</p></section>}
      <div className="q-editor-page"><section className="q-card q-editor-card">{note.deletedAt ? <div className="q-deleted-banner" role="status">This note is in Trash. Restore it to continue editing.</div> : null}
        <div className="q-editor-meta"><div className="q-editor-metadata"><NoteMetadataEditor title={autosave.title} tags={autosave.tags} disabled={view !== 'edit' || Boolean(note.deletedAt)} onTitleChange={(nextTitle) => autosave.changeMetadata({ title: nextTitle })} onTitleBlur={() => autosave.changeMetadata({ title: autosave.title.trim() || 'Untitled note' })} onTagsChange={(nextTags) => autosave.changeMetadata({ tags: nextTags })} /><div className="q-small">{note.slug} · updated {formatUpdatedAt(note.updatedAt)}</div>{autosave.errorMessage ? <div className="q-error q-editor-save-error" role="alert">{autosave.errorMessage}</div> : null}</div><SyncStatus status={syncing ? 'syncing' : autosave.status} savedAt={autosave.savedAt} onRetry={autosave.retry} /></div>
        <div className="q-editor-controls"><div className="q-toolbar q-editor-view-toggle" aria-label="Note view"><Button variant={view === 'edit' ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === 'edit'} onClick={enterEdit}>Edit</Button><Button variant={view === 'preview' ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</Button></div><NotebookPicker notebooks={notebooksQuery.data?.items ?? []} value={autosave.notebookId} disabled={Boolean(note.deletedAt) || movingNotebook || autosave.dirty || autosave.status === 'saving' || autosave.status === 'pending'} onChange={(notebookId) => void moveNotebook(notebookId)} /><div className="q-editor-actions"><NoteToolbar note={noteForCopy} onDelete={() => void updateDeletion('delete')} onRestore={() => void updateDeletion('restore')} onExport={() => void exportNote()} onShare={() => setShareOpen(true)} /></div></div>
        {view === 'edit' ? <EditorErrorBoundary><Suspense fallback={<div className="q-empty">Loading editor…</div>}><NoteEditor key={note.id} value={autosave.value} onChange={autosave.change} readOnly={Boolean(note.deletedAt)} autoFocus={focusEditor} /></Suspense></EditorErrorBoundary> : <NotePreview markdown={autosave.value} />}
        <div className="q-editor-footer"><span className="q-small">{note.deletedAt ? 'Read-only note in Trash.' : 'Markdown is saved after 800ms of quiet.'}</span>{conflict && !conflictOpen ? <Button type="button" variant="outline" size="sm" onClick={() => setConflictOpen(true)}>Review conflict</Button> : null}</div>
      </section>{!note.deletedAt ? <aside className="q-panel-stack"><AttachmentPanel noteId={note.id} attachments={attachmentsQuery.data ?? []} onRefresh={() => attachmentsQuery.refetch()} onCaptureFullPage={captureEntirePage} /></aside> : null}</div>
    </div>
    <ConflictResolver open={Boolean(conflict && conflictOpen)} busy={resolvingRemote} baseMarkdown={conflict?.baseMarkdown ?? note.contentMarkdown} localMarkdown={autosave.value} remoteNote={conflict?.remote ?? null} metadataConflicts={conflict?.metadataConflicts ?? []} remoteDeleted={conflict?.remoteDeleted ?? false} error={conflict?.error} onUseMine={saveMine} onUseRemote={saveRemote} onSaveMerged={saveMerged} onSaveAsNew={() => void saveAsNew()} onCancel={() => setConflictOpen(false)} />
    <Dialog open={blocker.status === 'blocked'} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}><DialogContent><DialogHeader><DialogTitle>Save is still pending</DialogTitle><DialogDescription>The server did not confirm the latest edit. Your local draft remains available. Retry, stay here, or leave only after the draft is durably stored on this account.</DialogDescription></DialogHeader><div className="q-dialog-actions"><Button variant="outline" onClick={() => blocker.reset?.()}>Stay and edit</Button><Button variant="secondary" onClick={() => { blocker.reset?.(); autosave.retry(); }}>Retry save</Button><Button onClick={() => void leaveWithDraft()}>Leave with draft</Button></div></DialogContent></Dialog>
    <Dialog open={deleteBlocked} onOpenChange={setDeleteBlocked}><DialogContent><DialogHeader><DialogTitle>Save is blocked</DialogTitle><DialogDescription>Your local draft is retained, but the server rejected or could not receive the latest changes. Keep editing and retry, or move the current server version to Trash while keeping this draft for recovery.</DialogDescription></DialogHeader><div className="q-dialog-actions"><Button variant="outline" onClick={() => setDeleteBlocked(false)}>Keep note</Button><Button variant="danger" onClick={() => void updateDeletion('delete', true)}>Delete anyway</Button></div></DialogContent></Dialog>
    <PublicShareDialog open={shareOpen} note={noteForCopy} share={shareQuery.data ?? null} loading={shareQuery.isPending} onOpenChange={setShareOpen} onBeforeCreate={flushBeforeShare} onRefresh={() => shareQuery.refetch()} />
  </AppShell>;
}
