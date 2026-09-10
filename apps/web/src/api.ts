import { QNotesClient, QVaultClient } from '@qnotes/api-client';
import { getSupabase } from './supabase';
import { env } from './env';

export const api = new QNotesClient({
  baseUrl: env.qnotesApiUrl,
  allowInsecureLoopback: import.meta.env.VITE_ALLOW_INSECURE_LOOPBACK === 'true',
  getAccessToken: async () => (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
});

export const vaultApi = new QVaultClient({
  baseUrl: env.qnotesApiUrl,
  allowInsecureLoopback: import.meta.env.VITE_ALLOW_INSECURE_LOOPBACK === 'true',
  getAccessToken: async () => (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
});
