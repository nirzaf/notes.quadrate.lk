import { readFile } from 'node:fs/promises';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Note, Attachment, NoteSummary } from '@qnotes/shared';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@qnotes.local', password: 'Qnotes-Test-Owner-2026!' } as const;
export const OTHER = { email: 'other@qnotes.local', password: 'Qnotes-Test-Other-2026!' } as const;
const TEST_USERS = [OWNER, OTHER] as const;

interface LocalEnv {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  apiUrl: string;
}

export async function localEnv(): Promise<LocalEnv> {
  return JSON.parse(await readFile('.tmp/local-env.json', 'utf8')) as LocalEnv;
}

async function removeObjects(client: ReturnType<typeof createClient>, prefix: string): Promise<void> {
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
  for (const table of ['search_documents', 'note_blocks', 'note_mutations', 'api_tokens', 'attachments', 'notes']) {
    const result = await client.from(table).delete().in('owner_id', ids);
    if (result.error) throw result.error;
  }
}

export async function signInSession(user = OWNER): Promise<Session> {
  const env = await localEnv();
  const client = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await client.auth.signInWithPassword(user);
  if (result.error || !result.data.session) throw result.error ?? new Error('No local Supabase session returned.');
  return result.data.session;
}

export async function signInPage(page: Page, user = OWNER): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible();
}

export async function createDevice(browser: Browser, user = OWNER): Promise<{ context: BrowserContext; page: Page }> {
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
  const response = await fetch(`${env.apiUrl}${path}`, { ...init, headers });
  const body = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text();
  return { response, body };
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
