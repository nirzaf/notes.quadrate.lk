import type { SearchSourceType } from '@qnotes/shared';
import { isUUID, MAX_BLOCK_KEY_LENGTH, MAX_SEARCH_QUERY_LENGTH, MAX_TAG_LENGTH } from '@qnotes/shared';

export const UNFILED_SEARCH_NOTEBOOK = '__unfiled__';

export function searchShortcutLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
}

const searchSources: SearchSourceType[] = ['note_chunk', 'copy_block', 'code_block', 'attachment_chunk'];

export interface AppSearchParams {
  q?: string;
  notebook?: string;
  tag?: string;
  source?: SearchSourceType;
  returnTo?: string;
  documentId?: string;
  blockKey?: string;
  attachmentId?: string;
}

export type AppSearchPatch = {
  [Key in keyof AppSearchParams]?: AppSearchParams[Key] | undefined;
};

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Search state is deliberately small and validated at the router boundary.
 * Drafts, tokens, signed URLs, and other private content never belong here.
 */
export function validateAppSearch(value: Record<string, unknown>): AppSearchParams {
  const q = optionalString(value.q, MAX_SEARCH_QUERY_LENGTH);
  const tag = optionalString(value.tag, MAX_TAG_LENGTH)?.toLowerCase();
  const rawNotebook = typeof value.notebook === 'string' ? value.notebook : undefined;
  const notebook = rawNotebook === UNFILED_SEARCH_NOTEBOOK || isUUID(rawNotebook) ? rawNotebook : undefined;
  const source = typeof value.source === 'string' && searchSources.includes(value.source as SearchSourceType) ? value.source as SearchSourceType : undefined;
  const returnTo = safeInternalPath(value.returnTo);
  const documentId = isUUID(value.documentId) ? value.documentId : undefined;
  const attachmentId = isUUID(value.attachmentId) ? value.attachmentId : undefined;
  const blockKey = optionalString(value.blockKey, MAX_BLOCK_KEY_LENGTH);
  return {
    ...(q ? { q } : {}),
    ...(notebook ? { notebook } : {}),
    ...(tag ? { tag } : {}),
    ...(source ? { source } : {}),
    ...(returnTo ? { returnTo } : {}),
    ...(documentId ? { documentId } : {}),
    ...(blockKey ? { blockKey } : {}),
    ...(attachmentId ? { attachmentId } : {}),
  };
}

/** Return destinations are paths in this SPA, never an external or protocol-relative URL. */
export function safeInternalPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return undefined;
  try {
    const origin = typeof window === 'undefined' ? 'https://qnotes.invalid' : window.location.origin;
    const url = new URL(value, origin);
    if (url.origin !== origin) return undefined;
    if (url.pathname === '/login') return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function currentAppPath(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function withoutSearchMatch(value: AppSearchParams): AppSearchParams {
  const { documentId: _documentId, blockKey: _blockKey, attachmentId: _attachmentId, ...search } = value;
  return search;
}

export function mergeSearchParams(current: AppSearchParams, patch: AppSearchPatch): AppSearchParams {
  return validateAppSearch({ ...current, ...patch });
}

export function withSearchMatch(value: AppSearchParams, match: { documentId?: string; blockKey?: string | null; attachmentId?: string | null }): AppSearchParams {
  return {
    ...withoutSearchMatch(value),
    ...(match.documentId && isUUID(match.documentId) ? { documentId: match.documentId } : {}),
    ...(match.blockKey ? { blockKey: match.blockKey } : {}),
    ...(match.attachmentId && isUUID(match.attachmentId) ? { attachmentId: match.attachmentId } : {}),
  };
}
