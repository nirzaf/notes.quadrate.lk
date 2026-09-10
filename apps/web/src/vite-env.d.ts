/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_QNOTES_API_URL?: string;
  readonly VITE_ALLOW_INSECURE_LOOPBACK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace JSX {
  type Element = import('react').JSX.Element;
}
