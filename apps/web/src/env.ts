export interface WebEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
  qnotesApiUrl: string;
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`QNotes configuration is missing ${name}. Create apps/web/.env.local with pnpm run local:env.`);
  return value.trim();
}

const supabaseUrl = required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL);
const supabasePublishableKey = required('VITE_SUPABASE_PUBLISHABLE_KEY', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

export const env: WebEnv = {
  supabaseUrl,
  supabasePublishableKey,
  qnotesApiUrl: import.meta.env.VITE_QNOTES_API_URL?.trim() || `${supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-api`,
};
