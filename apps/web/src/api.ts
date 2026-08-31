import { QNotesClient } from '@qnotes/api-client';
import { supabase } from './supabase';
import { env } from './env';

export const api = new QNotesClient({
  baseUrl: env.qnotesApiUrl,
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
});
