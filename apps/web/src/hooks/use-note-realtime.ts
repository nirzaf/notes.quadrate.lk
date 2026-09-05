import { useEffect } from 'react';
import type { RealtimeNoteEvent } from '@qnotes/shared';
import { supabase } from '../supabase';
import { useAuth } from '../auth-context';

function isRealtimeNoteEvent(value: unknown): value is RealtimeNoteEvent {
  return !!value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 1 && (value as { entity?: unknown }).entity === 'note' && typeof (value as { noteId?: unknown }).noteId === 'string';
}

export function useNoteRealtime(onEvent: (event: RealtimeNoteEvent) => void, onReconnect?: () => void): void {
  const { session } = useAuth();
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return undefined;
    const channel = supabase.channel(`user:${userId}:notes`, { config: { private: true } });
    let connected = false;
    let active = true;
    channel.on('broadcast', { event: 'note.changed' }, (payload) => {
      if (active && isRealtimeNoteEvent(payload.payload)) void Promise.resolve(onEvent(payload.payload)).catch(() => undefined);
    });
    void supabase.realtime.setAuth(session.access_token).then(() => {
      if (!active) return;
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (connected) void Promise.resolve(onReconnect?.()).catch(() => undefined);
          connected = true;
        }
      });
    }).catch(() => undefined);
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [onEvent, onReconnect, session?.access_token, session?.user.id]);
}
