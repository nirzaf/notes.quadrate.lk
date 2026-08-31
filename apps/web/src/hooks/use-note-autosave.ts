import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, SyncStatus } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { AutosaveCoordinator } from '@qnotes/sync';
import { api } from '../api';
import { draftStore, getDeviceId, rememberNote } from '../indexed-db';

interface SavePayload { markdown: string; }

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
  const saveHandler = useRef<((payload: SavePayload) => Promise<void>) | null>(null);
  const onSavedRef = useRef(onSaved);
  const onConflictRef = useRef(onConflict);
  const onDirtyRef = useRef(onDirtyChange);
  onSavedRef.current = onSaved;
  onConflictRef.current = onConflict;
  onDirtyRef.current = onDirtyChange;

  const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

  saveHandler.current = async ({ markdown }) => {
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
        if (valueRef.current === saved.contentMarkdown) coordinatorRef.current?.cancelPending();
        await draftStore.delete(saved.id);
        await rememberNote(saved);
        setAcknowledgedMutationId(mutationId);
        acknowledgedMutationIdRef.current = mutationId;
        setDirty(false);
        onDirtyRef.current?.(false);
        setStatus('saved');
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
      saveRevision.current += 1;
      coordinatorRef.current?.cancelPending();
      noteIdRef.current = note.id;
      authoritative.current = note;
      valueRef.current = note.contentMarkdown;
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
    void draftStore.get(note.id).then((draft) => {
      if (active && draft && draft.localMarkdown !== note.contentMarkdown && draft.baseVersion <= note.version) {
        valueRef.current = draft.localMarkdown;
        setValue(draft.localMarkdown);
        setDirty(true);
        onDirtyRef.current?.(true);
        setStatus('offline');
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
      coordinatorRef.current?.dispose();
    };
  }, []);

  const change = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
    const isDirty = next !== authoritative.current.contentMarkdown;
    setDirty(isDirty);
    onDirtyRef.current?.(isDirty);
    if (!isDirty) {
      void draftStore.delete(authoritative.current.id);
      setStatus('saved');
      return;
    }
    setStatus(navigator.onLine ? 'saving' : 'offline');
    void draftStore.put({ noteId: authoritative.current.id, baseVersion: authoritative.current.version, baseMarkdown: authoritative.current.contentMarkdown, localMarkdown: next, updatedAt: new Date().toISOString() }).catch(() => setStatus('offline'));
    coordinatorRef.current?.schedule({ markdown: next });
  }, []);

  const flush = useCallback(() => coordinatorRef.current?.flush() ?? Promise.resolve(), []);
  const adoptRemote = useCallback((nextNote: Note) => {
    saveRevision.current += 1;
    coordinatorRef.current?.cancelPending();
    authoritative.current = nextNote;
    valueRef.current = nextNote.contentMarkdown;
    setValue(nextNote.contentMarkdown);
    setDirty(false);
    setAcknowledgedMutationId(null);
    acknowledgedMutationIdRef.current = null;
    onDirtyRef.current?.(false);
    setStatus('saved');
    void draftStore.delete(nextNote.id);
  }, []);
  const acknowledgeMutation = useCallback((mutationId: string) => {
    acknowledgedMutationIdRef.current = mutationId;
    setAcknowledgedMutationId(mutationId);
  }, []);
  const isMutationAcknowledged = useCallback((mutationId: string) => acknowledgedMutationIdRef.current === mutationId, []);
  return { value, status, dirty, acknowledgedMutationId, change, flush, adoptRemote, acknowledgeMutation, isMutationAcknowledged };
}
