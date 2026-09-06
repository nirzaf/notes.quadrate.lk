import { useAuth } from '../auth-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateNoteInput, Note } from '@qnotes/shared';
import { api } from '../api';
import { getDeviceId } from '../indexed-db';

export type NewNotePreset = Partial<Pick<CreateNoteInput, 'title' | 'slug' | 'contentMarkdown' | 'tags'>>;

export function buildNewNoteInput(notebookId: string | null, preset: NewNotePreset = {}): CreateNoteInput {
  const mutationId = crypto.randomUUID();
  return {
    title: preset.title ?? 'Untitled note',
    slug: preset.slug ?? `untitled-note-${mutationId.slice(0, 8)}`,
    contentMarkdown: preset.contentMarkdown ?? '',
    tags: preset.tags ?? [],
    ...(notebookId ? { notebookId } : {}),
    deviceId: getDeviceId(),
    mutationId,
  };
}

interface UseCreateNoteOptions {
  notebookId: string | null;
  onCreated: (note: Note) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export function useCreateNote({ notebookId, onCreated, onError }: UseCreateNoteOptions): { create: (preset?: NewNotePreset) => Promise<void>; creating: boolean; error: unknown | null } {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const inFlightRef = useRef(false);
  const pendingInputRef = useRef<CreateNoteInput | null>(null);
  const mountedRef = useRef(true);
  const userIdRef = useRef(userId);
  const onCreatedRef = useRef(onCreated);
  const onErrorRef = useRef(onError);
  onCreatedRef.current = onCreated;
  onErrorRef.current = onError;
  userIdRef.current = userId;
  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { pendingInputRef.current = null; }, [userId]);

  const create = useCallback(async (preset?: NewNotePreset) => {
    if (inFlightRef.current || !userIdRef.current) return;
    const requestUserId = userIdRef.current;
    inFlightRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const input = pendingInputRef.current ?? buildNewNoteInput(notebookId, preset);
      pendingInputRef.current = input;
      const result = await api.createNoteDetailed(input);
      pendingInputRef.current = null;
      if (mountedRef.current && userIdRef.current === requestUserId) await onCreatedRef.current(result.note);
    } catch (nextError: unknown) {
      setError(nextError);
      if (mountedRef.current && userIdRef.current === requestUserId) onErrorRef.current?.(nextError);
    } finally {
      inFlightRef.current = false;
      setCreating(false);
    }
  }, [notebookId]);

  return { create, creating, error };
}
