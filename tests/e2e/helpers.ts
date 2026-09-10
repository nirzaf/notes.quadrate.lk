import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Note, Attachment, NoteSummary } from '@qnotes/shared';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@qnotes.local', password: 'Qnotes-Test-Owner-2026!' } as const;
export const OTHER = { email: 'other@qnotes.local', password: 'Qnotes-Test-Other-2026!' } as const;
const TEST_USERS = [OWNER, OTHER] as const;
type TestUser = (typeof TEST_USERS)[number];
const E2E_REQUEST_TIMEOUT_MS = 10_000;

const repoRoot = resolve(process.cwd());
const localHosts = new Set(['localhost', '127.0.0.1']);

function requestDeadline(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(E2E_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseLocalEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function localTarget(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`E2E local target check failed: ${label} is missing.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`E2E local target check failed: ${label} is not a valid URL.`);
  }
  if (url.protocol !== 'http:') throw new Error(`E2E local target check failed: ${label} must use http://.`);
  if (url.username || url.password) throw new Error(`E2E local target check failed: ${label} must not contain URL credentials.`);
  if (!localHosts.has(url.hostname)) throw new Error(`E2E local target check failed: ${label} must target localhost or 127.0.0.1.`);
  return url.href.replace(/\/+$/, '');
}

function requiredText(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`E2E local setup is incomplete: ${label} is missing. Run pnpm run local:env.`);
  return readFileSync(path, 'utf8');
}

/**
 * Validate the exact local targets before global setup or any E2E fixture can mutate data.
 * This runs at module load so direct Playwright invocations receive the same boundary.
 */
export function assertLocalE2ETargets(): void {
  const web = parseLocalEnv(requiredText(resolve(repoRoot, 'apps/web/.env.local'), 'apps/web/.env.local'));
  const functions = parseLocalEnv(requiredText(resolve(repoRoot, 'supabase/functions/.env.test'), 'supabase/functions/.env.test'));
  let local: Partial<LocalEnv>;
  try {
    local = JSON.parse(requiredText(resolve(repoRoot, '.tmp/local-env.json'), '.tmp/local-env.json')) as Partial<LocalEnv>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E local setup is incomplete:')) throw error;
    throw new Error('E2E local setup is invalid: .tmp/local-env.json is not valid JSON.');
  }
  if (!local || typeof local !== 'object' || Array.isArray(local)) {
    throw new Error('E2E local setup is invalid: .tmp/local-env.json must contain the local environment object.');
  }

  const supabaseUrl = localTarget(local.supabaseUrl, '.tmp/local-env.json supabaseUrl');
  const apiUrl = localTarget(local.apiUrl, '.tmp/local-env.json apiUrl');
  const expectedApiUrl = `${supabaseUrl}/functions/v1/qnotes-api`;
  if (apiUrl !== expectedApiUrl) throw new Error('E2E local target check failed: local API URL does not match local Supabase.');
  if (localTarget(web.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL') !== supabaseUrl) throw new Error('E2E local target check failed: web Supabase URL does not match local Supabase.');
  if (localTarget(web.VITE_QNOTES_API_URL, 'VITE_QNOTES_API_URL') !== apiUrl) throw new Error('E2E local target check failed: web API URL does not match local API.');
  if (localTarget(functions.SUPABASE_URL, 'SUPABASE_URL') !== supabaseUrl) throw new Error('E2E local target check failed: function Supabase URL does not match local Supabase.');

  const origins = (functions.QNOTES_ALLOWED_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('E2E local setup is invalid: QNOTES_ALLOWED_ORIGIN is missing.');
  origins.forEach((origin, index) => localTarget(origin, `QNOTES_ALLOWED_ORIGIN entry ${index + 1}`));

  const inheritedTargets: Record<string, string> = {
    QNOTES_URL: apiUrl,
    SUPABASE_URL: supabaseUrl,
    VITE_SUPABASE_URL: supabaseUrl,
    VITE_QNOTES_API_URL: apiUrl,
  };
  for (const [name, expected] of Object.entries(inheritedTargets)) {
    if (process.env[name] && localTarget(process.env[name], `inherited ${name}`) !== expected) {
      throw new Error(`E2E local target check failed: inherited ${name} does not match the local target.`);
    }
  }
  if (process.env.QNOTES_E2E_EXTERNAL_API && !['0', '1'].includes(process.env.QNOTES_E2E_EXTERNAL_API)) {
    throw new Error('E2E local target check failed: QNOTES_E2E_EXTERNAL_API must be 0 or 1.');
  }
}

assertLocalE2ETargets();


interface LocalEnv {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  apiUrl: string;
}

export async function localEnv(): Promise<LocalEnv> {
  return JSON.parse(await readFile('.tmp/local-env.json', 'utf8')) as LocalEnv;
}

async function removeObjects(client: SupabaseClient<any, 'notesdb'>, prefix: string): Promise<void> {
  const storage = client.storage.from('note-attachments');
  const { data, error } = await storage.list(prefix, { limit: 1000 });
  if (error) throw error;
  const files: string[] = [];
  for (const item of data ?? []) {
    const path = `${prefix}/${item.name}`;
    if (item.id) files.push(path);
    else await removeObjects(client, path);
  }
  if (files.length) {
    const removed = await storage.remove(files);
    if (removed.error) throw removed.error;
  }
}

export async function clearApplicationData(): Promise<void> {
  const env = await localEnv();
  const client = createClient(env.supabaseUrl, env.serviceRoleKey, { db: { schema: 'notesdb' }, auth: { autoRefreshToken: false, persistSession: false } });
  const listing = await client.auth.admin.listUsers({ page: 1, perPage: 100 });
  if (listing.error) throw listing.error;
  const ids: string[] = [];
  for (const user of TEST_USERS) {
    const found = listing.data.users.find((candidate) => candidate.email === user.email);
    if (!found) throw new Error(`Missing local E2E user ${user.email}. Run pnpm run seed:test-users.`);
    ids.push(found.id);
    await removeObjects(client, found.id);
  }
  for (const table of ['vault_operation_approvals', 'vault_audit_events', 'vault_mutations', 'vault_agent_tokens', 'vault_projects']) {
    const result = await client.from(table).delete().in('owner_id', ids);
    if (result.error) throw result.error;
  }
  for (const table of ['search_documents', 'note_blocks', 'note_mutations', 'api_tokens', 'attachments', 'notes', 'notebooks']) {
    const result = await client.from(table).delete().in('owner_id', ids);
    if (result.error) throw result.error;
  }
}

export async function signInSession(user: TestUser = OWNER): Promise<Session> {
  const env = await localEnv();
  const client = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await client.auth.signInWithPassword(user);
  if (result.error || !result.data.session) throw result.error ?? new Error('No local Supabase session returned.');
  return result.data.session;
}

export async function signInPage(page: Page, user: TestUser = OWNER): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.q-working-header h2')).toBeVisible();
}

export async function expectPreviewMode(page: Page): Promise<void> {
  await expect(page.getByLabel('Rendered note preview')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
}

export async function expectEditorMode(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
}

export async function createDevice(browser: Browser, user: TestUser = OWNER): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInPage(page, user);
  return { context, page };
}

export async function apiJson(path: string, token: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const env = await localEnv();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${env.apiUrl}${path}`, { ...init, headers, signal: requestDeadline(init.signal) });
  const body = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text();
  return { response, body };
}

export async function publicApiJson(path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const env = await localEnv();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${env.apiUrl}${path}`, { ...init, headers, signal: requestDeadline(init.signal) });
  const body = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text();
  return { response, body };
}

export function searchItems(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || !('items' in data)) return [];
  const items = (data as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

export async function poll<T>(read: () => Promise<T> | T, matches: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (matches(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return last!;
}

export function mutationIds(): { deviceId: string; mutationId: string } {
  return { deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() };
}

export async function createNoteApi(token: string, title: string, contentMarkdown = ''): Promise<Note> {
  const { response, body } = await apiJson('/api/notes', token, { method: 'POST', body: JSON.stringify({ title, contentMarkdown, tags: [], ...mutationIds() }) });
  if (!response.ok || !isDataEnvelope(body)) throw new Error(JSON.stringify(body));
  return body.data as Note;
}

export async function getNoteApi(token: string, noteRef: string, includeDeleted = false): Promise<Note> {
  const path = includeDeleted ? `/api/notes/${encodeURIComponent(noteRef)}?includeDeleted=true` : `/api/notes/${encodeURIComponent(noteRef)}`;
  const { response, body } = await apiJson(path, token);
  if (!response.ok || !isDataEnvelope(body)) throw new Error(JSON.stringify(body));
  return body.data as Note;
}

export async function listNotesApi(token: string, includeDeleted = false): Promise<NoteSummary[]> {
  const { response, body } = await apiJson(`/api/notes?includeDeleted=${includeDeleted}`, token);
  if (!response.ok || !isDataEnvelope(body)) throw new Error(JSON.stringify(body));
  const data = body.data as { items?: unknown };
  return Array.isArray(data.items) ? data.items as NoteSummary[] : [];
}

export async function updateNoteApi(token: string, note: Note, contentMarkdown: string, title = note.title): Promise<Note> {
  const { response, body } = await apiJson(`/api/notes/${note.id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title, slug: note.slug, contentMarkdown, tags: note.tags, expectedVersion: note.version, ...mutationIds() }),
  });
  if (!response.ok || !isDataEnvelope(body)) throw new Error(JSON.stringify(body));
  return body.data as Note;
}

export async function createPublicShareApi(token: string, noteId: string, expiresAt: string | null = null): Promise<{ token: string; metadata: Record<string, unknown> }> {
  const result = await apiJson(`/api/notes/${noteId}/share`, token, { method: 'POST', body: JSON.stringify({ expiresAt }) });
  if (result.response.status !== 201 || !isDataEnvelope(result.body)) throw new Error(JSON.stringify(result.body));
  return result.body.data as { token: string; metadata: Record<string, unknown> };
}

export async function resolvePublicShareApi(token: string): Promise<{ response: Response; body: unknown }> {
  return publicApiJson('/public/share/resolve', { method: 'POST', body: JSON.stringify({ token }) });
}


export async function listAttachmentsApi(token: string, noteRef: string): Promise<Attachment[]> {
  const { response, body } = await apiJson(`/api/notes/${encodeURIComponent(noteRef)}/attachments`, token);
  if (!response.ok || !isDataEnvelope(body)) throw new Error(JSON.stringify(body));
  return body.data as Attachment[];
}

export async function workerSecret(): Promise<string> {
  const text = await readFile('supabase/functions/.env.test', 'utf8');
  const line = text.split(/\r?\n/).find((value) => value.startsWith('QNOTES_INTERNAL_WORKER_SECRET='));
  if (!line) throw new Error('Missing local worker secret.');
  return line.slice('QNOTES_INTERNAL_WORKER_SECRET='.length);
}

export async function invokeWorker(name: 'embedding-worker' | 'attachment-worker'): Promise<unknown> {
  const env = await localEnv();
  const secret = await workerSecret();
  const response = await fetch(`${env.supabaseUrl}/functions/v1/${name}`, { method: 'POST', headers: { 'x-qnotes-worker-secret': secret, 'content-type': 'application/json' }, body: '{}' });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function isDataEnvelope(value: unknown): value is { data: unknown } {
  return !!value && typeof value === 'object' && 'data' in value;
}
