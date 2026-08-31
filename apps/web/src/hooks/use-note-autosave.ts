import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, SyncStatus } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { AutosaveCoordinator } from '@qnotes/sync';
import { api } from '../api';
import { draftStore, getDeviceId, rememberNote } from '../indexed-db';

interface SavePayload { markdown: string; editRevision: number; }

interface UseNoteAutosaveOptions {
  note: Note;
  onSaved: (note: Note) => void;
  onConflict: (error: QNotesHttpError) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function useNoteAutosave({ note, onSaved, onConflict, onDirtyChange }: UseNoteAutosaveOptions) {
  const [value, setValue] = useState(note.contentMarkdown);
  const [status, setStatus] = useState<SyncStatus>('saved');
  const [dirty, setDirty] = useState(false);
  const [acknowledgedMutationId, setAcknowledgedMutationId] = useState<string | null>(null);
  const authoritative = useRef(note);
  const valueRef = useRef(value);
  const noteIdRef = useRef(note.id);
  const acknowledgedMutationIdRef = useRef<string | null>(null);
  const saveRevision = useRef(0);
  const editRevision = useRef(0);
  const dirtyRef = useRef(false);
  const saveHandler = useRef<((payload: SavePayload) => Promise<void>) | null>(null);
  const onSavedRef = useRef(onSaved);
  const onConflictRef = useRef(onConflict);
  const onDirtyRef = useRef(onDirtyChange);
  onSavedRef.current = onSaved;
  onConflictRef.current = onConflict;
  onDirtyRef.current = onDirtyChange;

  const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

  saveHandler.current = async ({ markdown, editRevision: payloadRevision }) => {
    const revision = saveRevision.current;
    const current = authoritative.current;
    const mutationId = crypto.randomUUID();
    const payload = {
      title: current.title,
      slug: current.slug,
      contentMarkdown: markdown,
      tags: current.tags,
      expectedVersion: current.version,
      deviceId: getDeviceId(),
      mutationId,
    };
    const retryDelays = [0, 1000, 2000, 4000, 8000, 16000, 30000];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (revision !== saveRevision.current) return;
      if (retryDelays[attempt]! > 0) {
        setStatus('error');
        await sleep(retryDelays[attempt]!);
      }
      if (revision !== saveRevision.current) return;
      try {
        const saved = await api.updateNote(current.id, payload);
        if (revision !== saveRevision.current) return;
        authoritative.current = saved;
        setAcknowledgedMutationId(mutationId);
        acknowledgedMutationIdRef.current = mutationId;
        void rememberNote(saved).catch(() => undefined);
        if (payloadRevision === editRevision.current || valueRef.current === saved.contentMarkdown) {
          valueRef.current = saved.contentMarkdown;
          dirtyRef.current = false;
          setValue(saved.contentMarkdown);
          coordinatorRef.current?.cancelPending();
          void draftStore.delete(saved.id).catch(() => undefined);
          setDirty(false);
          onDirtyRef.current?.(false);
          setStatus('saved');
        } else {
          dirtyRef.current = true;
          setDirty(true);
          onDirtyRef.current?.(true);
          setStatus(navigator.onLine ? 'saving' : 'offline');
          coordinatorRef.current?.schedule({ markdown: valueRef.current, editRevision: editRevision.current });
        }
        onSavedRef.current(saved);
        return;
      } catch (error: unknown) {
        if (revision !== saveRevision.current) return;
        if (error instanceof QNotesHttpError && error.code === 'NOTE_VERSION_CONFLICT') {
          setStatus('conflict');
          onConflictRef.current(error);
          throw error;
        }
        const transient = !(error instanceof QNotesHttpError) || error.status >= 500;
        if (!transient || attempt === retryDelays.length - 1) throw error;
      }
    }
  };

  const coordinatorRef = useRef<AutosaveCoordinator<SavePayload> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new AutosaveCoordinator({
      delayMs: 800,
      save: async (payload) => {
        if (!saveHandler.current) return;
        await saveHandler.current(payload);
      },
      onError: (error: unknown) => {
        if (error instanceof QNotesHttpError && error.code === 'NOTE_VERSION_CONFLICT') return;
        setStatus(navigator.onLine ? 'error' : 'offline');
      },
    });
  }

  useEffect(() => {
    if (note.id !== noteIdRef.current) {
      void coordinatorRef.current?.flush();
      saveRevision.current += 1;
      noteIdRef.current = note.id;
      authoritative.current = note;
      valueRef.current = note.contentMarkdown;
      editRevision.current = 0;
      dirtyRef.current = false;
      setValue(note.contentMarkdown);
      setDirty(false);
      setAcknowledgedMutationId(null);
      acknowledgedMutationIdRef.current = null;
      setStatus('saved');
      onDirtyRef.current?.(false);
    } else if (!dirty) {
      authoritative.current = note;
      if (!dirty && valueRef.current !== note.contentMarkdown) {
        valueRef.current = note.contentMarkdown;
        setValue(note.contentMarkdown);
      }
    }
  }, [dirty, note]);

  useEffect(() => {
    let active = true;
    const requestedNoteId = note.id;
    const requestedMarkdown = note.contentMarkdown;
    const requestedVersion = note.version;
    void draftStore.get(note.id).then((draft) => {
      if (active && noteIdRef.current === requestedNoteId && !dirtyRef.current && valueRef.current === requestedMarkdown && draft && draft.localMarkdown !== requestedMarkdown && draft.baseVersion <= requestedVersion) {
        editRevision.current += 1;
        valueRef.current = draft.localMarkdown;
        dirtyRef.current = true;
        setValue(draft.localMarkdown);
        setDirty(true);
        onDirtyRef.current?.(true);
        setStatus(navigator.onLine ? 'saving' : 'offline');
        coordinatorRef.current?.schedule({ markdown: draft.localMarkdown, editRevision: editRevision.current });
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [note.id, note.contentMarkdown, note.version]);

  useEffect(() => {
    const updateOnline = () => setStatus((current) => current === 'saved' ? current : navigator.onLine ? 'saving' : 'offline');
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
      const coordinator = coordinatorRef.current;
      if (coordinator) void coordinator.flush().finally(() => coordinator.dispose());
    };
  }, []);

  const change = useCallback((next: string) => {
    editRevision.current += 1;
    valueRef.current = next;
    setValue(next);
    const isDirty = next !== authoritative.current.contentMarkdown;
    dirtyRef.current = isDirty;
    setDirty(isDirty);
    onDirtyRef.current?.(isDirty);
    if (!isDirty) {
      coordinatorRef.current?.cancelPending();
      void draftStore.delete(authoritative.current.id).catch(() => undefined);
      setStatus('saved');
      return;
    }
    setStatus(navigator.onLine ? 'saving' : 'offline');
    const revision = editRevision.current;
    void draftStore.put({ noteId: authoritative.current.id, baseVersion: authoritative.current.version, baseMarkdown: authoritative.current.contentMarkdown, localMarkdown: next, updatedAt: new Date().toISOString() }).catch(() => {
      if (revision === editRevision.current) setStatus('offline');
    });
    coordinatorRef.current?.schedule({ markdown: next, editRevision: revision });
  }, []);

  const flush = useCallback(() => coordinatorRef.current?.flush() ?? Promise.resolve(), []);
  const adoptRemote = useCallback((nextNote: Note) => {
    saveRevision.current += 1;
    coordinatorRef.current?.cancelPending();
    authoritative.current = nextNote;
    valueRef.current = nextNote.contentMarkdown;
    editRevision.current = 0;
    dirtyRef.current = false;
    setValue(nextNote.contentMarkdown);
    setDirty(false);
    setAcknowledgedMutationId(null);
    acknowledgedMutationIdRef.current = null;
    onDirtyRef.current?.(false);
    setStatus('saved');
    void draftStore.delete(nextNote.id).catch(() => undefined);
  }, []);
  const acknowledgeMutation = useCallback((mutationId: string) => {
    acknowledgedMutationIdRef.current = mutationId;
    setAcknowledgedMutationId(mutationId);
  }, []);
  const isMutationAcknowledged = useCallback((mutationId: string) => acknowledgedMutationIdRef.current === mutationId, []);
  return { value, status, dirty, acknowledgedMutationId, change, flush, adoptRemote, acknowledgeMutation, isMutationAcknowledged };
}
