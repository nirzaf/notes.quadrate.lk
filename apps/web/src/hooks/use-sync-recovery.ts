import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { removeRememberedNote, readSyncCursor, writeSyncCursor } from '../indexed-db';
import { useAuth } from '../auth-context';

export function useSyncRecovery(): { syncing: boolean; recover: () => Promise<void> } {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const recover = useCallback(async () => {
    if (!session) return;
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
    }
  }, [queryClient, session]);
  useEffect(() => { void recover().catch(() => setSyncing(false)); }, [recover]);
  return { syncing, recover };
}
