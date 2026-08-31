import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { removeRememberedNote, readSyncCursor, writeSyncCursor } from '../indexed-db';
import { useAuth } from '../auth-context';

export function useSyncRecovery(): { syncing: boolean; recover: () => Promise<void> } {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const recoveryRef = useRef<Promise<void> | null>(null);
  const recover = useCallback((): Promise<void> => {
    if (!session) return Promise.resolve();
    if (recoveryRef.current) return recoveryRef.current;
    const recovery = (async () => {
      setSyncing(true);
      try {
        let cursor = await readSyncCursor();
        let hasMore = true;
        while (hasMore) {
          const page = await api.sync(cursor ?? undefined);
          for (const change of page.changes) {
            if (change.deletedAt) await removeRememberedNote(change.noteId);
            await queryClient.invalidateQueries({ queryKey: ['note', change.noteId] });
          }
          cursor = page.nextCursor;
          hasMore = page.hasMore;
        }
        await writeSyncCursor(cursor);
        await queryClient.invalidateQueries({ queryKey: ['notes'] });
      } finally {
        setSyncing(false);
        recoveryRef.current = null;
      }
    })();
    recoveryRef.current = recovery;
    return recovery;
  }, [queryClient, session]);
  useEffect(() => {
    const run = () => { void recover().catch(() => setSyncing(false)); };
    run();
    window.addEventListener('online', run);
    return () => window.removeEventListener('online', run);
  }, [recover]);
  return { syncing, recover };
}
