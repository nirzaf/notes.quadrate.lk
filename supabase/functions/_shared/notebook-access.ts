import type { SearchFilters } from '@qnotes/shared';
import { ApiError } from './errors.ts';
import type { AuthContext } from './auth.ts';

const NO_NOTEBOOK_ACCESS_ID = '00000000-0000-4000-8000-000000000000';

export interface ScopedSearchPlan {
  notebookIds: string[];
  allowUnfiled: boolean;
  filters: SearchFilters;
  empty: boolean;
}

export function authPrincipal(auth: AuthContext): string {
  return `${auth.authKind}:${auth.tokenId ?? auth.userId}`;
}

export function authPolicyKey(auth: AuthContext): string {
  return `${authPrincipal(auth)}:${auth.policyRevision}`;
}

export function isAccountWide(auth: AuthContext): boolean {
  return auth.authKind === 'jwt' || auth.accessMode === 'account';
}

export function canAccessNotebook(auth: AuthContext, notebookId: string | null): boolean {
  return isAccountWide(auth) || (notebookId === null ? auth.allowUnfiled : auth.notebookIds.includes(notebookId));
}

export function assertNoteAccess(auth: AuthContext, notebookId: string | null): void {
  if (!canAccessNotebook(auth, notebookId)) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
}

export function assertNotebookAccess(auth: AuthContext, notebookId: string): void {
  if (!isAccountWide(auth) && !auth.notebookIds.includes(notebookId)) throw new ApiError(404, 'NOTEBOOK_NOT_FOUND', 'The notebook was not found.');
}

export function assertUnfiledAccess(auth: AuthContext): void {
  if (!isAccountWide(auth) && !auth.allowUnfiled) throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
}

export function requireAccountWide(auth: AuthContext, message: string): void {
  if (!isAccountWide(auth)) throw new ApiError(403, 'RESOURCE_SCOPE_REQUIRED', message);
}

export function applyNotebookAccess<T>(builder: T, auth: AuthContext, column = 'notebook_id'): T {
  if (isAccountWide(auth)) return builder;
  const clauses = [
    ...(auth.allowUnfiled ? [`${column}.is.null`] : []),
    ...(auth.notebookIds.length ? [`${column}.in.(${auth.notebookIds.join(',')})`] : []),
  ];
  if (!clauses.length) return (builder as { eq: (field: string, value: string) => T }).eq('id', NO_NOTEBOOK_ACCESS_ID);
  return (builder as { or: (filters: string) => T }).or(clauses.join(','));
}

export function applyNotebookIdAccess<T>(builder: T, auth: AuthContext): T {
  if (isAccountWide(auth)) return builder;
  return auth.notebookIds.length
    ? (builder as { in: (field: string, values: string[]) => T }).in('id', auth.notebookIds)
    : (builder as { eq: (field: string, value: string) => T }).eq('id', NO_NOTEBOOK_ACCESS_ID);
}

export function scopedSearchPlan(auth: AuthContext, requested: SearchFilters): ScopedSearchPlan {
  if (isAccountWide(auth)) return { notebookIds: [], allowUnfiled: true, filters: requested, empty: false };
  const requestedIds = requested.notebookIds?.length ? requested.notebookIds : null;
  if (requestedIds && requested.unfiled === true) return { notebookIds: [], allowUnfiled: false, filters: withoutScopeFilters(requested), empty: true };
  if (requested.unfiled === true) return { notebookIds: [], allowUnfiled: auth.allowUnfiled, filters: withoutScopeFilters(requested), empty: !auth.allowUnfiled };
  const notebookIds = requestedIds ? auth.notebookIds.filter((id) => requestedIds.includes(id)) : [...auth.notebookIds];
  const allowUnfiled = requestedIds ? false : requested.unfiled === false ? false : auth.allowUnfiled;
  return { notebookIds, allowUnfiled, filters: withoutScopeFilters(requested), empty: notebookIds.length === 0 && !allowUnfiled };
}

function withoutScopeFilters(filters: SearchFilters): SearchFilters {
  const { notebookIds: _notebookIds, unfiled: _unfiled, ...remaining } = filters;
  return remaining;
}

export function requireCursorPolicy(auth: AuthContext, principal: unknown, policyRevision: unknown): void {
  if (principal !== authPrincipal(auth) || policyRevision !== auth.policyRevision) throw new ApiError(422, 'VALIDATION_ERROR', 'cursor is invalid or expired.');
}
