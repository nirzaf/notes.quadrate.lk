import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { removeRememberedNote, readSyncCursor, writeSyncCursor } from '../indexed-db';
import { useAuth } from '../auth-context';
import { runSyncRecovery } from '../sync-recovery-core';

export function useSyncRecovery(): { syncing: boolean; recover: () => Promise<void> } {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const recoveryRef = useRef<Promise<void> | null>(null);
  const recoveryUserIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const recover = useCallback((): Promise<void> => {
    if (!userId) return Promise.resolve();
    if (recoveryRef.current && recoveryUserIdRef.current === userId) return recoveryRef.current;
    if (recoveryRef.current && recoveryUserIdRef.current !== userId) {
      abortRef.current?.abort();
      recoveryRef.current = null;
      recoveryUserIdRef.current = null;
    }
    const recoveryUserId = userId;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const recovery = (async () => {
      setSyncing(true);
      try {
        await runSyncRecovery({
          userId: recoveryUserId,
          queryClient,
          api,
          readSyncCursor,
          writeSyncCursor,
          removeRememberedNote,
          generation,
          getGeneration: () => generationRef.current,
          signal: controller.signal,
        });
      } finally {
        if (generation === generationRef.current) setSyncing(false);
        if (abortRef.current === controller) {
          recoveryRef.current = null;
          recoveryUserIdRef.current = null;
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
    recoveryRef.current = recovery;
    return recovery;
  }, [queryClient, userId]);
  useEffect(() => {
    const run = () => { void recover().catch(() => setSyncing(false)); };
    run();
    window.addEventListener('online', run);
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      window.removeEventListener('online', run);
    };
  }, [recover]);
  return { syncing, recover };
}
