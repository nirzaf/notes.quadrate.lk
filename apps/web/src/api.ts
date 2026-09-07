import { QNotesClient, QVaultClient } from '@qnotes/api-client';
import { getSupabase } from './supabase';
import { env } from './env';

export const api = new QNotesClient({
  baseUrl: env.qnotesApiUrl,
  getAccessToken: async () => (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
});

export const vaultApi = new QVaultClient({
  baseUrl: env.qnotesApiUrl,
  getAccessToken: async () => (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
});
