import { inflateRawSync } from 'node:zlib';
import { test, expect } from './test-fixtures';
import { createClient } from '@supabase/supabase-js';
import { apiJson, createNoteApi, createPublicShareApi, getNoteApi, listAttachmentsApi, listNotesApi, localEnv, mutationIds, OTHER, resolvePublicShareApi, signInSession } from './helpers';

function data<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  return (body as { data: T }).data;
}

async function exportWorkspace(token: string): Promise<Uint8Array> {
  const env = await localEnv();
  const response = await fetch(`${env.apiUrl}/api/export/workspace`, {
    headers: { Accept: 'application/zip', Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/zip');
  return new Uint8Array(await response.arrayBuffer());
}

async function importWorkspace(token: string, archive: Uint8Array, query: string): Promise<{ response: Response; body: unknown }> {
  const env = await localEnv();
  const response = await fetch(`${env.apiUrl}/api/import/workspace${query}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: archive as unknown as BodyInit,
  });
  const body = await response.json();
  return { response, body };
}

type VaultProject = { id: string; slug: string; name: string; description: string | null };
type VaultEnvironment = { id: string; projectId: string; slug: string; name: string; description: string | null };
type VaultSecret = { id: string; projectId: string; environmentId: string; name: string; description: string | null; version: number };
type VaultAgentToken = { id: string; name: string; tokenPrefix: string; grants: Array<Record<string, unknown>> };

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function archiveEntries(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const minimumEndRecordOffset = Math.max(0, archive.byteLength - 65_557);
  let endRecordOffset = -1;
  for (let offset = archive.byteLength - 22; offset >= minimumEndRecordOffset; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error('The workspace archive has no end record.');
  if (readUint16(view, endRecordOffset + 4) !== 0 || readUint16(view, endRecordOffset + 6) !== 0) throw new Error('The workspace archive spans multiple disks.');
  const entryCount = readUint16(view, endRecordOffset + 10);
  const centralDirectorySize = readUint32(view, endRecordOffset + 12);
  const centralDirectoryOffset = readUint32(view, endRecordOffset + 16);
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) throw new Error('ZIP64 workspace archives are not supported by this focused test.');
  if (centralDirectoryOffset + centralDirectorySize > archive.byteLength) throw new Error('The workspace archive central directory is outside the archive.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, Uint8Array>();
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, cursor) !== 0x02014b50) throw new Error('The workspace archive has an invalid central-directory entry.');
    const compressionMethod = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const fileNameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > archive.byteLength || compressedSize > archive.byteLength) throw new Error('The workspace archive entry is outside the archive.');
    const path = decoder.decode(archive.slice(cursor + 46, cursor + 46 + fileNameLength));
    if (entries.has(path)) throw new Error('The workspace archive contains a duplicate entry.');
    if (localHeaderOffset + 30 > archive.byteLength) throw new Error('The workspace archive entry is outside the archive.');
    if (readUint32(view, localHeaderOffset) !== 0x04034b50) throw new Error('The workspace archive has an invalid local entry.');
    const localNameLength = readUint16(view, localHeaderOffset + 26);
    const localExtraLength = readUint16(view, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.byteLength) throw new Error('The workspace archive entry data is outside the archive.');
    const compressed = archive.slice(dataStart, dataEnd);
    const bytes = compressionMethod === 0 ? compressed : compressionMethod === 8 ? new Uint8Array(inflateRawSync(compressed)) : null;
    if (!bytes || bytes.byteLength !== uncompressedSize) throw new Error('The workspace archive entry could not be safely decompressed.');
    entries.set(path, bytes);
    cursor = entryEnd;
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) throw new Error('The workspace archive central directory has trailing bytes.');
  return entries;
}

function decodedArchiveText(entries: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  return [...entries.entries()].map(([path, bytes]) => `${path}\n${decoder.decode(bytes)}`).join('\n');
}

function containsAnyValue(value: unknown, needles: readonly string[]): boolean {
  if (typeof value === 'string') return needles.some((needle) => needle.length > 0 && value.includes(needle));
  if (Array.isArray(value)) return value.some((item) => containsAnyValue(item, needles));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsAnyValue(item, needles));
  return false;
}

async function createVaultIsolationFixture(token: string): Promise<{
  project: VaultProject;
  environment: VaultEnvironment;
  secret: VaultSecret;
  qvtToken: string;
  agentToken: VaultAgentToken;
  secretValue: string;
  auditPurpose: string;
  marker: string;
}> {
  const marker = `vault-isolation-${crypto.randomUUID()}`;
  const secretValue = `${marker}-value-${crypto.randomUUID()}`;
  const secretName = `ISOLATION_${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const projectResponse = await apiJson('/vault/projects', token, { method: 'POST', body: JSON.stringify({ name: `${marker}-project`, slug: `${marker}-project` }) });
  expect(projectResponse.response.status).toBe(201);
  const project = data<VaultProject>(projectResponse.body);
  const environmentResponse = await apiJson(`/vault/projects/${project.id}/environments`, token, { method: 'POST', body: JSON.stringify({ name: `${marker}-environment`, slug: `${marker}-environment` }) });
  expect(environmentResponse.response.status).toBe(201);
  const environment = data<VaultEnvironment>(environmentResponse.body);
  const secretResponse = await apiJson(`/vault/environments/${environment.id}/secrets`, token, {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, environmentId: environment.id, name: secretName, description: `${marker}-description`, value: secretValue, mutationId: crypto.randomUUID() }),
  });
  expect(secretResponse.response.status).toBe(201);
  const secret = data<VaultSecret>(secretResponse.body);
  const tokenName = `${marker}-agent`;
  const tokenResponse = await apiJson('/vault/agent-tokens', token, {
    method: 'POST',
    body: JSON.stringify({ name: tokenName, expiresAt: null, grants: [{ projectId: project.id, environmentId: environment.id, secretId: secret.id, action: 'secret:reveal' }] }),
  });
  expect(tokenResponse.response.status).toBe(201);
  const tokenData = data<{ token: string; metadata: VaultAgentToken }>(tokenResponse.body);
  const qvtToken = tokenData.token;
  const agentToken = tokenData.metadata;
  const auditPurpose = `${marker}-reveal-purpose`;
  const revealResponse = await apiJson('/vault/secrets/reveal', qvtToken, {
    method: 'POST',
    body: JSON.stringify({ project: project.slug, environment: environment.slug, name: secret.name, purpose: auditPurpose }),
  });
  expect(revealResponse.response.status).toBe(200);
  const revealedValue = data<{ value?: unknown }>(revealResponse.body).value;
  expect(revealedValue === secretValue).toBe(true);
  return { project, environment, secret, qvtToken, agentToken, secretValue, auditPurpose, marker };
}

async function readVaultState(token: string): Promise<unknown> {
  const projectsResponse = await apiJson('/vault/projects', token);
  expect(projectsResponse.response.status).toBe(200);
  const projects = data<VaultProject[]>(projectsResponse.body);
  const environments: VaultEnvironment[] = [];
  const secrets: VaultSecret[] = [];
  for (const project of projects) {
    const environmentsResponse = await apiJson(`/vault/projects/${project.id}/environments`, token);
    expect(environmentsResponse.response.status).toBe(200);
    for (const environment of data<VaultEnvironment[]>(environmentsResponse.body)) {
      environments.push(environment);
      const secretsResponse = await apiJson(`/vault/environments/${environment.id}/secrets`, token);
      expect(secretsResponse.response.status).toBe(200);
      secrets.push(...data<VaultSecret[]>(secretsResponse.body));
    }
  }
  const tokensResponse = await apiJson('/vault/agent-tokens', token);
  expect(tokensResponse.response.status).toBe(200);
  const auditResponse = await apiJson('/vault/audit', token);
  expect(auditResponse.response.status).toBe(200);
  return { projects, environments, secrets, tokens: data<VaultAgentToken[]>(tokensResponse.body), audit: data<unknown[]>(auditResponse.body) };
}

test('keeps Vault fixtures out of Notes archives, imports, and public shares', async () => {
  test.setTimeout(45_000);
  const source = await signInSession();
  const note = await createNoteApi(source.access_token, `Notes isolation ${crypto.randomUUID()}`, '# Notes export isolation\n\nThis synthetic Notes fixture must survive the round trip.');
  const fixture = await createVaultIsolationFixture(source.access_token);
  const auditResponse = await apiJson('/vault/audit', source.access_token);
  expect(auditResponse.response.status).toBe(200);
  const auditEvents = data<unknown[]>(auditResponse.body);
  const tokenListResponse = await apiJson('/vault/agent-tokens', source.access_token);
  expect(tokenListResponse.response.status).toBe(200);
  const listedAgentToken = data<VaultAgentToken[]>(tokenListResponse.body).find((item) => item.id === fixture.agentToken.id);
  expect(Boolean(listedAgentToken?.grants.some((grant) => grant.projectId === fixture.project.id && grant.environmentId === fixture.environment.id && grant.secretId === fixture.secret.id && grant.action === 'secret:reveal'))).toBe(true);

  const publicShare = await createPublicShareApi(source.access_token, note.id);
  const archive = await exportWorkspace(source.access_token);
  const entries = archiveEntries(archive);
  const archiveText = decodedArchiveText(entries);
  const vaultMaterial = [
    fixture.marker,
    fixture.secretValue,
    fixture.project.id,
    fixture.project.slug,
    fixture.project.name,
    fixture.environment.id,
    fixture.environment.slug,
    fixture.environment.name,
    fixture.secret.id,
    fixture.secret.name,
    fixture.secret.description ?? '',
    fixture.qvtToken,
    fixture.agentToken.id,
    fixture.agentToken.name,
    fixture.agentToken.tokenPrefix,
    fixture.auditPurpose,
    ...Object.values(fixture.agentToken.grants ?? []).flatMap((grant) => Object.values(grant).filter((value): value is string => typeof value === 'string')),
    ...auditEvents.flatMap((event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
      return Object.values(event).filter((value): value is string => typeof value === 'string');
    }),
  ];
  expect([...entries.keys()].sort()).toEqual(['manifest.json', `notes/${note.slug}-${note.id}.md`].sort());
  expect(containsAnyValue(archiveText, vaultMaterial)).toBe(false);

  const resolved = await resolvePublicShareApi(publicShare.token);
  expect(resolved.response.status).toBe(200);
  expect(Object.keys(resolved.body as Record<string, unknown>).sort()).toEqual(['data']);
  const resolvedBody = data<Record<string, unknown>>(resolved.body);
  expect(Object.keys(resolvedBody).sort()).toEqual(['contentMarkdown', 'title', 'updatedAt'].sort());
  expect(resolvedBody.title === note.title && resolvedBody.contentMarkdown === note.contentMarkdown && typeof resolvedBody.updatedAt === 'string').toBe(true);
  expect(containsAnyValue(resolved.body, vaultMaterial)).toBe(false);

  const target = await signInSession(OTHER);
  const beforeTargetVault = await readVaultState(target.access_token);
  const dryRun = await importWorkspace(target.access_token, archive, '?dryRun=true');
  expect(dryRun.response.status).toBe(200);
  expect(data<{ dryRun: boolean; ready: boolean }>(dryRun.body)).toMatchObject({ dryRun: true, ready: true });
  expect(containsAnyValue(dryRun.body, vaultMaterial)).toBe(false);
  expect(JSON.stringify(await readVaultState(target.access_token)) === JSON.stringify(beforeTargetVault)).toBe(true);

  const confirmed = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(confirmed.response.status).toBe(200);
  expect(data<{ dryRun: boolean; ready: boolean }>(confirmed.body)).toMatchObject({ dryRun: false, ready: true });
  expect(containsAnyValue(confirmed.body, vaultMaterial)).toBe(false);
  expect(JSON.stringify(await readVaultState(target.access_token)) === JSON.stringify(beforeTargetVault)).toBe(true);
});

test('restores notebooks, tagged notes, and attachments without duplicating on retry', async () => {
  const source = await signInSession();
  const notebookName = `Recovery ${crypto.randomUUID()}`;
  const notebookResponse = await apiJson('/api/notebooks', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: notebookName }),
  });
  expect(notebookResponse.response.status).toBe(201);
  const notebook = data<{ id: string; name: string }>(notebookResponse.body);

  const title = `Round-trip ${crypto.randomUUID()}`;
  const contentMarkdown = '# Recovery round trip\n\nThe note and its private attachment must survive export and import.';
  const noteResponse = await apiJson('/api/notes', source.access_token, {
    method: 'POST',
    body: JSON.stringify({
      title,
      contentMarkdown,
      tags: ['recovery', 'round-trip'],
      notebookId: notebook.id,
      ...mutationIds(),
    }),
  });
  expect(noteResponse.response.status).toBe(201);
  const note = data<{ id: string; title: string }>(noteResponse.body);

  const bytes = new TextEncoder().encode('private recovery attachment');
  const requested = await apiJson('/api/attachments/upload-url', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ noteId: note.id, fileName: 'recovery.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength }),
  });
  expect(requested.response.status).toBe(201);
  const upload = data<{ path: string; token: string; attachment: { id: string } }>(requested.body);
  const env = await localEnv();
  const storage = createClient(env.supabaseUrl, env.publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const uploaded = await storage.storage.from('note-attachments').uploadToSignedUrl(
    upload.path,
    upload.token,
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/plain' }),
  );
  if (uploaded.error) throw uploaded.error;
  const finalized = await apiJson(`/api/attachments/${upload.attachment.id}/finalize`, source.access_token, { method: 'POST' });
  expect(finalized.response.status).toBe(200);
  await createPublicShareApi(source.access_token, note.id);
  const sourceToken = await apiJson('/api/tokens', source.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: `Recovery token ${crypto.randomUUID()}`, scopes: ['notes:read'], expiresAt: null }),
  });
  expect(sourceToken.response.status).toBe(201);

  const archive = await exportWorkspace(source.access_token);
  const target = await signInSession(OTHER);
  expect(await listNotesApi(target.access_token)).toHaveLength(0);

  const dryRun = await importWorkspace(target.access_token, archive, '?dryRun=true');
  expect(dryRun.response.status).toBe(200);
  expect(data<{ dryRun: boolean; ready: boolean; notebooks: number; notes: number; attachments: number }>(dryRun.body)).toMatchObject({ dryRun: true, ready: true, notebooks: 1, notes: 1, attachments: 1 });
  expect(await listNotesApi(target.access_token)).toHaveLength(0);

  const restored = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(restored.response.status).toBe(200);
  expect(data<{ dryRun: boolean; notebooks: number; notes: number; attachments: number }>(restored.body)).toMatchObject({ dryRun: false, notebooks: 1, notes: 1, attachments: 1 });

  const importedNotebook = data<{ items: Array<{ id: string; name: string }> }>((await apiJson('/api/notebooks', target.access_token)).body).items.find((item) => item.name === notebookName);
  expect(importedNotebook).toBeDefined();
  const importedNote = (await listNotesApi(target.access_token)).find((item) => item.title === title);
  expect(importedNote).toMatchObject({ title, tags: ['recovery', 'round-trip'], notebookId: importedNotebook!.id });
  const importedFullNote = await getNoteApi(target.access_token, importedNote!.id);
  expect(importedFullNote.contentMarkdown).toBe(contentMarkdown);
  const importedAttachments = await listAttachmentsApi(target.access_token, importedNote!.id);
  expect(importedAttachments).toEqual([
    expect.objectContaining({ originalFileName: 'recovery.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength }),
  ]);
  const download = await apiJson(`/api/attachments/${importedAttachments[0]!.id}`, target.access_token);
  const signedUrl = data<{ signedUrl: string }>(download.body).signedUrl;
  const downloaded = await fetch(signedUrl);
  expect(downloaded.status).toBe(200);
  expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual(Array.from(bytes));
  const importedShare = await apiJson(`/api/notes/${importedNote!.id}/share`, target.access_token);
  expect(importedShare.response.status).toBe(200);
  expect(data<null>(importedShare.body)).toBeNull();
  const importedTokens = await apiJson('/api/tokens', target.access_token);
  expect(importedTokens.response.status).toBe(200);
  expect(data<unknown[]>(importedTokens.body)).toHaveLength(0);

  const retry = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(retry.response.status).toBe(200);
  expect(data<{ dryRun: boolean; notebooks: number; notes: number; attachments: number }>(retry.body)).toMatchObject({ dryRun: false, notebooks: 1, notes: 1, attachments: 1 });
  expect((await listNotesApi(target.access_token)).filter((item) => item.title === title)).toHaveLength(1);
  expect((await listAttachmentsApi(target.access_token, importedNote!.id)).filter((item) => item.originalFileName === 'recovery.txt')).toHaveLength(1);
});

test('reports import conflicts without mutating the target workspace', async () => {
  const source = await signInSession();
  const title = `Conflict ${crypto.randomUUID()}`;
  const sourceNote = await createNoteApi(source.access_token, title, '# Source note');
  const archive = await exportWorkspace(source.access_token);

  const target = await signInSession(OTHER);
  const existing = await createNoteApi(target.access_token, title, '# Existing note');
  const before = await listNotesApi(target.access_token);
  expect(before).toHaveLength(1);

  const dryRun = await importWorkspace(target.access_token, archive, '?dryRun=true');
  expect(dryRun.response.status).toBe(200);
  const dryRunData = data<{ ready: boolean; conflicts: Array<{ kind: string; reason: string; value: string }> }>(dryRun.body);
  expect(dryRunData.ready).toBe(false);
  expect(dryRunData.conflicts).toEqual([expect.objectContaining({ kind: 'note', reason: 'slug_exists', value: sourceNote.slug })]);
  expect(await listNotesApi(target.access_token)).toEqual(before);

  const confirmed = await importWorkspace(target.access_token, archive, '?confirm=true');
  expect(confirmed.response.status).toBe(409);
  expect((confirmed.body as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');
  expect(await listNotesApi(target.access_token)).toEqual(before);
  expect((await getNoteApi(target.access_token, existing.id)).contentMarkdown).toBe('# Existing note');
});
