import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, SyncStatus } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { AutosaveCoordinator, reconcileDraft, type DraftValues } from '@qnotes/sync';
import { api } from '../api';
import { getAccountDraftStore, getDeviceId, rememberNote } from '../indexed-db';
import { useAuth } from '../auth-context';

interface SavePayload extends DraftValues {
  editRevision: number;
  noteId: string;
  userId: string;
}

interface DraftBaseSnapshot {
  baseVersion: number;
  baseMarkdown: string;
  baseTitle?: string;
  baseTags?: string[];
  baseNotebookId?: Note['notebookId'];
}

interface UseNoteAutosaveOptions {
  note: Note;
  onSaved: (note: Note) => void;
  onConflict: (error: QNotesHttpError) => void;
  onDirtyChange?: (dirty: boolean) => void;
  readOnly?: boolean;
  enabled?: boolean;
}

function valuesFromNote(note: Note): DraftValues {
  return { markdown: note.contentMarkdown, title: note.title, tags: [...note.tags], notebookId: note.notebookId };
}

function tagsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function valuesEqual(left: DraftValues, right: DraftValues): boolean {
  return left.markdown === right.markdown && left.title === right.title && tagsEqual(left.tags, right.tags) && left.notebookId === right.notebookId;
}

export function useNoteAutosave({ note, onSaved, onConflict, onDirtyChange, readOnly = false, enabled = true }: UseNoteAutosaveOptions) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const store = useMemo(() => userId ? getAccountDraftStore(userId) : null, [userId]);
  const [value, setValue] = useState(note.contentMarkdown);
  const [title, setTitle] = useState(note.title);
  const [tags, setTags] = useState<string[]>(note.tags);
  const [notebookId, setNotebookId] = useState<Note['notebookId']>(note.notebookId);
  const [savedAt, setSavedAt] = useState(note.updatedAt);
  const [status, setStatus] = useState<SyncStatus>('saved');
  const [dirty, setDirty] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acknowledgedMutationId, setAcknowledgedMutationId] = useState<string | null>(null);
  const authoritative = useRef(note);
  const draftRef = useRef<DraftValues>(valuesFromNote(note));
  const valueRef = useRef(value);
  const noteIdRef = useRef(note.id);
  const acknowledgedMutationIdRef = useRef<string | null>(null);
  const pendingMutationIdRef = useRef<string | null>(null);
  const pendingNotebookMutationIdRef = useRef<string | null>(null);
  const reconciliationBlockedRef = useRef(false);
  const blockedDraftBaseRef = useRef<DraftBaseSnapshot | null>(null);
  const saveRevision = useRef(0);
  const editRevision = useRef(0);
  const dirtyRef = useRef(false);
  const draftPersistedRef = useRef(false);
  const draftStorageFailedRef = useRef(false);
  const mountedRef = useRef(true);
  const statusRef = useRef<SyncStatus>('saved');
  const readOnlyRef = useRef(readOnly);
  const enabledRef = useRef(enabled);
  const userIdRef = useRef(userId);
  const saveHandler = useRef<((payload: SavePayload) => Promise<void>) | null>(null);
  const onSavedRef = useRef(onSaved);
  const onConflictRef = useRef(onConflict);
  const onDirtyRef = useRef(onDirtyChange);
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  onSavedRef.current = onSaved;
  onConflictRef.current = onConflict;
  onDirtyRef.current = onDirtyChange;
  readOnlyRef.current = readOnly;
  enabledRef.current = enabled;
  userIdRef.current = userId;
  statusRef.current = status;

  const online = () => typeof navigator === 'undefined' || navigator.onLine;
  const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
  const currentPayload = (): SavePayload => ({ ...draftRef.current, tags: [...draftRef.current.tags], editRevision: editRevision.current, noteId: authoritative.current.id, userId: userIdRef.current ?? '' });
  const markDirty = (next: DraftValues): boolean => {
    const isDirty = !valuesEqual(next, valuesFromNote(authoritative.current));
    draftRef.current = next;
    valueRef.current = next.markdown;
    setValue(next.markdown);
    setTitle(next.title);
    setTags([...next.tags]);
    setNotebookId(next.notebookId);
    dirtyRef.current = isDirty;
    setDirty(isDirty);
    onDirtyRef.current?.(isDirty);
    return isDirty;
  };

  const persistDraft = (revision: number): Promise<void> => {
    const base = authoritative.current;
    const blockedBase = blockedDraftBaseRef.current;
    const local = draftRef.current;
    const mutationId = pendingMutationIdRef.current ?? crypto.randomUUID();
    const notebookMutationId = pendingNotebookMutationIdRef.current;
    pendingMutationIdRef.current = mutationId;
    const write = draftWriteChainRef.current.then(async () => {
      if (!store || !userIdRef.current) throw new Error('Local draft storage is unavailable for this account.');
      await store.put({
        noteId: base.id,
        baseVersion: blockedBase?.baseVersion ?? base.version,
        baseMarkdown: blockedBase?.baseMarkdown ?? base.contentMarkdown,
        localMarkdown: local.markdown,
        mutationId,
        ...(notebookMutationId ? { notebookMutationId } : {}),
        baseTitle: blockedBase?.baseTitle ?? base.title,
        localTitle: local.title,
        baseTags: [...(blockedBase?.baseTags ?? base.tags)],
        localTags: [...local.tags],
        baseNotebookId: blockedBase?.baseNotebookId !== undefined ? blockedBase.baseNotebookId : base.notebookId,
        localNotebookId: local.notebookId,
        updatedAt: new Date().toISOString(),
      });
    }).then(() => {
      if (!mountedRef.current || revision !== editRevision.current) return;
      draftPersistedRef.current = true;
      draftStorageFailedRef.current = false;
      if (!online()) setStatus('offline');
    }).catch((error: unknown) => {
      if (!mountedRef.current || revision !== editRevision.current) return;
      draftPersistedRef.current = false;
      draftStorageFailedRef.current = true;
      setErrorMessage(error instanceof Error ? error.message : 'Local draft storage is unavailable.');
      setStatus('storage-error');
      throw error;
    });
    draftWriteChainRef.current = write.catch(() => undefined);
    return write;
  };
  const deleteDraft = (noteId: string): Promise<void> => {
    const deletion = draftWriteChainRef.current.then(async () => {
      if (store) await store.delete(noteId);
    });
    draftWriteChainRef.current = deletion.catch(() => undefined);
    return deletion;
  };

  saveHandler.current = async (payload) => {
    if (!mountedRef.current || readOnlyRef.current || !enabledRef.current || !userIdRef.current) throw new Error('This note session is no longer authenticated.');
    if (reconciliationBlockedRef.current) return;
    const revision = saveRevision.current;
    let current = authoritative.current;
    if (payload.noteId !== current.id || payload.userId !== userIdRef.current) throw new Error('This note save belongs to an inactive session.');
    const mutationId = pendingMutationIdRef.current ?? crypto.randomUUID();
    pendingMutationIdRef.current = mutationId;
    if (payload.notebookId !== current.notebookId) {
      const notebookMutationId = pendingNotebookMutationIdRef.current ?? crypto.randomUUID();
      pendingNotebookMutationIdRef.current = notebookMutationId;
      try {
        setStatus('saving');
        const moved = await api.moveNoteToNotebook(current.id, { notebookId: payload.notebookId, expectedVersion: current.version, deviceId: getDeviceId(), mutationId: notebookMutationId });
        if (!mountedRef.current || revision !== saveRevision.current) return;
        current = moved;
        authoritative.current = moved;
        setSavedAt(moved.updatedAt);
        void rememberNote(moved, userIdRef.current).catch(() => undefined);
        onSavedRef.current(moved);
        pendingNotebookMutationIdRef.current = null;
        await persistDraft(editRevision.current);
      } catch (error: unknown) {
        if (revision !== saveRevision.current) return;
        if (error instanceof QNotesHttpError && error.code === 'NOTE_VERSION_CONFLICT') {
          setErrorMessage(error.message);
          setStatus('conflict');
          onConflictRef.current(error);
        } else if (error instanceof QNotesHttpError && error.status < 500) {
          setErrorMessage(error.message);
          setStatus('validation-error');
          pendingNotebookMutationIdRef.current = null;
        }
        throw error;
      }
    }
    const normalizedTitle = payload.title.trim() || 'Untitled note';
    const bodyUnchanged = normalizedTitle === current.title && payload.markdown === current.contentMarkdown && tagsEqual(payload.tags, current.tags);
    const requestPayload = {
      title: normalizedTitle,
      slug: current.slug,
      contentMarkdown: payload.markdown,
      tags: payload.tags,
      expectedVersion: current.version,
      deviceId: getDeviceId(),
      mutationId,
    };
    const retryDelays = [0, 1000, 3000];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (revision !== saveRevision.current) return;
      if (retryDelays[attempt]! > 0) {
        setStatus('network-error');
        await sleep(retryDelays[attempt]!);
      }
      if (revision !== saveRevision.current) return;
      if (!online()) throw new Error('Network unavailable.');
      setStatus('saving');
      try {
        const saved = bodyUnchanged ? current : await api.updateNote(current.id, requestPayload);
        if (!mountedRef.current || revision !== saveRevision.current) return;
        authoritative.current = saved;
        setSavedAt(saved.updatedAt);
        setAcknowledgedMutationId(mutationId);
        acknowledgedMutationIdRef.current = mutationId;
        void rememberNote(saved, userIdRef.current).catch(() => undefined);
        if (payload.editRevision === editRevision.current) {
          draftRef.current = valuesFromNote(saved);
          valueRef.current = saved.contentMarkdown;
          dirtyRef.current = false;
          setValue(saved.contentMarkdown);
          setTitle(saved.title);
          setTags([...saved.tags]);
          coordinatorRef.current?.cancelPending();
          void deleteDraft(saved.id).catch(() => undefined);
          draftPersistedRef.current = false;
          draftStorageFailedRef.current = false;
          setDirty(false);
          onDirtyRef.current?.(false);
          setErrorMessage(null);
          setStatus('saved');
          pendingMutationIdRef.current = null;
        } else {
          dirtyRef.current = true;
          setDirty(true);
          onDirtyRef.current?.(true);
          setStatus(online() ? 'pending' : draftPersistedRef.current ? 'offline' : 'storage-error');
          void persistDraft(editRevision.current).catch(() => undefined);
          coordinatorRef.current?.schedule(currentPayload());
        }
        onSavedRef.current(saved);
        return;
      } catch (error: unknown) {
        if (revision !== saveRevision.current) return;
        if (error instanceof QNotesHttpError && error.code === 'NOTE_VERSION_CONFLICT') {
          setErrorMessage(error.message);
          setStatus('conflict');
          pendingMutationIdRef.current = null;
          onConflictRef.current(error);
          throw error;
        }
        if (error instanceof QNotesHttpError && error.status < 500) {
          setErrorMessage(error.message);
          setStatus('validation-error');
          pendingMutationIdRef.current = null;
          throw error;
        }
        if (attempt === retryDelays.length - 1) throw error;
      }
    }
  };

  const coordinatorRef = useRef<AutosaveCoordinator<SavePayload> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new AutosaveCoordinator({
      delayMs: 800,
      save: async (payload) => {
        if (saveHandler.current) await saveHandler.current(payload);
      },
      onError: (error: unknown) => {
        if (!mountedRef.current) return;
        if (error instanceof QNotesHttpError && error.code === 'NOTE_VERSION_CONFLICT') return;
        if (error instanceof QNotesHttpError && error.status < 500) return;
        if (draftStorageFailedRef.current) {
          setErrorMessage('Local draft storage is unavailable.');
          setStatus('storage-error');
          return;
        }
        if (!online()) {
          setStatus(draftStorageFailedRef.current ? 'storage-error' : draftPersistedRef.current ? 'offline' : 'storage-error');
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : 'The note could not be saved.');
        setStatus('network-error');
      },
    });
  }

  useEffect(() => {
    if (note.id !== noteIdRef.current) {
      coordinatorRef.current?.cancelPending();
      saveRevision.current += 1;
      noteIdRef.current = note.id;
      pendingMutationIdRef.current = null;
      pendingNotebookMutationIdRef.current = null;
      reconciliationBlockedRef.current = false;
      blockedDraftBaseRef.current = null;
      authoritative.current = note;
      draftRef.current = valuesFromNote(note);
      valueRef.current = note.contentMarkdown;
      editRevision.current = 0;
      dirtyRef.current = false;
      draftPersistedRef.current = false;
      draftStorageFailedRef.current = false;
      setValue(note.contentMarkdown);
      setTitle(note.title);
      setTags([...note.tags]);
      setNotebookId(note.notebookId);
      setSavedAt(note.updatedAt);
      setDirty(false);
      setAcknowledgedMutationId(null);
      acknowledgedMutationIdRef.current = null;
      setErrorMessage(null);
      setStatus('saved');
      onDirtyRef.current?.(false);
    } else if (!dirtyRef.current) {
      authoritative.current = note;
      const next = valuesFromNote(note);
      draftRef.current = next;
      if (valueRef.current !== note.contentMarkdown) {
        valueRef.current = note.contentMarkdown;
        setValue(note.contentMarkdown);
      }
      setTitle(note.title);
      setTags([...note.tags]);
      setNotebookId(note.notebookId);
      setSavedAt(note.updatedAt);
    }
  }, [note]);

  useEffect(() => {
    let active = true;
    const requestedNoteId = note.id;
    const requestedUserId = userId;
    if (!store || !userId) return () => { active = false; };
    void store.get(note.id).then((draft) => {
      if (!active || !enabledRef.current || noteIdRef.current !== requestedNoteId || userIdRef.current !== requestedUserId || dirtyRef.current || !draft) return;
      const restored = reconcileDraft(draft, note);
      const restoredValues = restored.values;
      reconciliationBlockedRef.current = restored.status === 'conflict';
      blockedDraftBaseRef.current = restored.status === 'conflict' ? {
        baseVersion: draft.baseVersion,
        baseMarkdown: draft.baseMarkdown,
        ...(draft.baseTitle !== undefined ? { baseTitle: draft.baseTitle } : {}),
        ...(draft.baseTags !== undefined ? { baseTags: [...draft.baseTags] } : {}),
        ...(draft.baseNotebookId !== undefined ? { baseNotebookId: draft.baseNotebookId } : {}),
      } : null;
      pendingMutationIdRef.current = draft.mutationId ?? crypto.randomUUID();
      pendingNotebookMutationIdRef.current = restoredValues.notebookId !== note.notebookId
        ? draft.notebookMutationId ?? crypto.randomUUID()
        : null;
      if (restored.status === 'clean' && draft.baseVersion < note.version) {
        pendingMutationIdRef.current = crypto.randomUUID();
        if (restoredValues.notebookId !== note.notebookId) pendingNotebookMutationIdRef.current = crypto.randomUUID();
      }
      if (restored.status === 'clean' && valuesEqual(restoredValues, valuesFromNote(note))) {
        void deleteDraft(note.id).catch(() => undefined);
        pendingMutationIdRef.current = null;
        pendingNotebookMutationIdRef.current = null;
        return;
      }
      editRevision.current += 1;
      draftPersistedRef.current = true;
      markDirty(restoredValues);
      if (restored.status === 'conflict') {
        const message = restored.reason === 'remote-deleted'
          ? 'This note was deleted on another device. Your local draft is preserved.'
          : restored.reason === 'newer-base'
            ? 'This local draft is based on a newer version that is not available here. Review it before saving.'
            : 'This local draft could not be safely reconciled with the saved note. Review it before saving.';
        const error = new QNotesHttpError(409, 'NOTE_VERSION_CONFLICT', message, crypto.randomUUID(), {
          currentVersion: note.version,
          currentNote: note,
          conflicts: restored.conflicts,
          metadataConflicts: restored.metadataConflicts,
          reconciledValues: restored.values,
          draftBaseVersion: draft.baseVersion,
          baseMarkdown: draft.baseMarkdown,
          draftReason: restored.reason,
          deleted: restored.reason === 'remote-deleted',
        });
        setErrorMessage(message);
        setStatus('conflict');
        onConflictRef.current(error);
        return;
      }
      setErrorMessage(null);
      const revision = editRevision.current;
      void persistDraft(revision).then(() => {
        if (!active || !mountedRef.current || revision !== editRevision.current || noteIdRef.current !== requestedNoteId || userIdRef.current !== requestedUserId) return;
        setStatus(online() ? 'pending' : 'offline');
        coordinatorRef.current?.schedule(currentPayload());
      }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (!active || noteIdRef.current !== requestedNoteId || userIdRef.current !== requestedUserId) return;
      setErrorMessage(error instanceof Error ? error.message : 'Local draft storage is unavailable.');
      setStatus('storage-error');
    });
    return () => { active = false; };
  }, [enabled, note.id, note.version, store, userId]);

  useEffect(() => {
    const updateOnline = () => {
      if (!dirtyRef.current) return;
      if (navigator.onLine) {
        if (statusRef.current !== 'offline' && statusRef.current !== 'network-error' && statusRef.current !== 'error') return;
        setStatus('pending');
        coordinatorRef.current?.schedule(currentPayload());
      } else if (draftPersistedRef.current) {
        setStatus('offline');
      } else {
        setStatus('storage-error');
      }
    };
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      mountedRef.current = false;
      saveRevision.current += 1;
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
      const coordinator = coordinatorRef.current;
      coordinator?.dispose();
    };
  }, []);

  const change = useCallback((next: string) => {
    if (readOnlyRef.current) return;
    editRevision.current += 1;
    pendingMutationIdRef.current = crypto.randomUUID();
    const nextValues = { ...draftRef.current, markdown: next, tags: [...draftRef.current.tags] };
    const isDirty = markDirty(nextValues);
    if (!reconciliationBlockedRef.current) setErrorMessage(null);
    if (reconciliationBlockedRef.current) {
      setStatus('conflict');
      void persistDraft(editRevision.current).catch(() => undefined);
      return;
    }
    if (!isDirty) {
      coordinatorRef.current?.cancelPending();
      void deleteDraft(authoritative.current.id).catch(() => undefined);
      pendingMutationIdRef.current = null;
      pendingNotebookMutationIdRef.current = null;
      draftPersistedRef.current = false;
      draftStorageFailedRef.current = false;
      setStatus('saved');
      return;
    }
    setStatus('pending');
    void persistDraft(editRevision.current).catch(() => undefined);
    coordinatorRef.current?.schedule(currentPayload());
  }, []);

  const changeMetadata = useCallback((next: { title?: string; tags?: string[] }) => {
    if (readOnlyRef.current) return;
    editRevision.current += 1;
    pendingMutationIdRef.current = crypto.randomUUID();
    const nextValues = {
      ...draftRef.current,
      title: next.title ?? draftRef.current.title,
      tags: next.tags ? [...next.tags] : [...draftRef.current.tags],
    };
    const isDirty = markDirty(nextValues);
    if (!reconciliationBlockedRef.current) setErrorMessage(null);
    if (reconciliationBlockedRef.current) {
      setStatus('conflict');
      void persistDraft(editRevision.current).catch(() => undefined);
      return;
    }
    if (!isDirty) {
      coordinatorRef.current?.cancelPending();
      void deleteDraft(authoritative.current.id).catch(() => undefined);
      pendingMutationIdRef.current = null;
      pendingNotebookMutationIdRef.current = null;
      draftPersistedRef.current = false;
      setStatus('saved');
      return;
    }
    setStatus('pending');
    void persistDraft(editRevision.current).catch(() => undefined);
    coordinatorRef.current?.schedule(currentPayload());
  }, []);
  const changeNotebook = useCallback((next: Note['notebookId']) => {
    if (readOnlyRef.current) return;
    editRevision.current += 1;
    pendingNotebookMutationIdRef.current = next === authoritative.current.notebookId ? null : crypto.randomUUID();
    const isDirty = markDirty({ ...draftRef.current, notebookId: next, tags: [...draftRef.current.tags] });
    if (!reconciliationBlockedRef.current) setErrorMessage(null);
    if (reconciliationBlockedRef.current) {
      setStatus('conflict');
      void persistDraft(editRevision.current).catch(() => undefined);
      return;
    }
    if (!isDirty) {
      coordinatorRef.current?.cancelPending();
      void deleteDraft(authoritative.current.id).catch(() => undefined);
      pendingMutationIdRef.current = null;
      pendingNotebookMutationIdRef.current = null;
      draftPersistedRef.current = false;
      draftStorageFailedRef.current = false;
      setStatus('saved');
      return;
    }
    setStatus('pending');
    void persistDraft(editRevision.current).catch(() => undefined);
    coordinatorRef.current?.schedule(currentPayload());
  }, []);

  const flush = useCallback(async () => {
    try {
      await (coordinatorRef.current?.flush() ?? Promise.resolve());
    } catch (error: unknown) {
      await draftWriteChainRef.current;
      throw error;
    }
  }, []);
  const preserveDraft = useCallback(async () => {
    if (!dirtyRef.current) return;
    await persistDraft(editRevision.current);
  }, []);
  const retry = useCallback(() => {
    if (!dirtyRef.current || readOnlyRef.current || reconciliationBlockedRef.current) return;
    setErrorMessage(null);
    setStatus('pending');
    coordinatorRef.current?.schedule(currentPayload());
  }, []);
  const adoptRemote = useCallback((nextNote: Note) => {
    saveRevision.current += 1;
    pendingMutationIdRef.current = null;
    pendingNotebookMutationIdRef.current = null;
    reconciliationBlockedRef.current = false;
    blockedDraftBaseRef.current = null;
    coordinatorRef.current?.cancelPending();
    authoritative.current = nextNote;
    draftRef.current = valuesFromNote(nextNote);
    valueRef.current = nextNote.contentMarkdown;
    editRevision.current = 0;
    dirtyRef.current = false;
    draftPersistedRef.current = false;
    draftStorageFailedRef.current = false;
    setValue(nextNote.contentMarkdown);
    setTitle(nextNote.title);
    setTags([...nextNote.tags]);
    setNotebookId(nextNote.notebookId);
    setSavedAt(nextNote.updatedAt);
    setDirty(false);
    setAcknowledgedMutationId(null);
    acknowledgedMutationIdRef.current = null;
    onDirtyRef.current?.(false);
    setErrorMessage(null);
    setStatus('saved');
    void deleteDraft(nextNote.id).catch(() => undefined);
  }, [store]);
  const blockAutosave = useCallback(() => {
    saveRevision.current += 1;
    if (!blockedDraftBaseRef.current) {
      const current = authoritative.current;
      blockedDraftBaseRef.current = {
        baseVersion: current.version,
        baseMarkdown: current.contentMarkdown,
        baseTitle: current.title,
        baseTags: [...current.tags],
        baseNotebookId: current.notebookId,
      };
    }
    reconciliationBlockedRef.current = true;
    coordinatorRef.current?.cancelPending();
    setStatus('conflict');
  }, []);
  const acknowledgeMutation = useCallback((mutationId: string) => {
    acknowledgedMutationIdRef.current = mutationId;
    setAcknowledgedMutationId(mutationId);
  }, []);
  const isMutationAcknowledged = useCallback((mutationId: string) => acknowledgedMutationIdRef.current === mutationId, []);
  return { value, title, tags, notebookId, status, savedAt, dirty, errorMessage, acknowledgedMutationId, change, changeMetadata, changeNotebook, flush, preserveDraft, retry, adoptRemote, blockAutosave, acknowledgeMutation, isMutationAcknowledged };
}
