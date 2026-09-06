import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './supabase';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  authError: Error | null;
  retryInitialization: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren): JSX.Element {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<Error | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let currentUserId: string | null = null;
    const updateSession = (nextSession: Session | null) => {
      const nextUserId = nextSession?.user.id ?? null;
      if (currentUserId !== nextUserId) {
        void queryClient.cancelQueries({ queryKey: ['qnotes'] }).catch(() => undefined);
        queryClient.removeQueries({ queryKey: ['qnotes'] });
      }
      currentUserId = nextUserId;
      setSession(nextSession);
      setAuthError(null);
      setLoading(false);
    };
    setLoading(true);
    setAuthError(null);
    const supabase = getSupabase();
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) throw error;
      updateSession(data.session);
    }).catch((error: unknown) => {
      if (!active) return;
      setSession(null);
      setAuthError(error instanceof Error ? error : new Error('Authentication could not be initialized.'));
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) updateSession(nextSession);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [initializationAttempt, queryClient]);
  const value = useMemo<AuthContextValue>(() => ({
    session,
    loading,
    authError,
    retryInitialization: () => setInitializationAttempt((attempt) => attempt + 1),
    signIn: async (email, password) => {
      const result = await getSupabase().auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
    },
    signUp: async (email, password) => {
      const result = await getSupabase().auth.signUp({ email, password });
      if (result.error) throw result.error;
    },
    signOut: async () => {
      const result = await getSupabase().auth.signOut();
      if (result.error) throw result.error;
    },
  }), [authError, loading, session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider.');
  return value;
}
