import { strFromU8, unzipSync } from 'fflate';
import { MarkdownParseError, parseMarkdown, sha256Hex } from '@qnotes/markdown';
import { MAX_MARKDOWN_CODE_UNITS, isUUID } from '@qnotes/shared';
import { MAX_EXPORT_ENTRIES } from './export-preflight.ts';

const SAFE_PATH = /^(?:manifest\.json|notes\/[^/]+\.md|attachments\/[^/]+\/[^/]+)$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MIME_TYPES = new Set(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

export type WorkspaceImportItemKind = 'notebook' | 'note' | 'attachment';

export interface WorkspaceBackupManifestAttachment {
  id: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

export interface WorkspaceBackupManifestNote {
  id: string;
  slug: string;
  title: string;
  tags: string[];
  notebookId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  markdownPath: string;
  attachments: WorkspaceBackupManifestAttachment[];
}

export interface WorkspaceBackupManifest {
  format: 'quadrate-notes-workspace';
  formatVersion: 2;
  backupId: string;
  exportedAt: string;
  notebooks: { id: string; name: string; createdAt: string; updatedAt: string }[];
  notes: WorkspaceBackupManifestNote[];
}

export class WorkspaceArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceArchiveError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new WorkspaceArchiveError(`Backup manifest field ${field} is invalid.`);
  return value;
}

function safeArchivePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..') || !SAFE_PATH.test(value)) {
    throw new WorkspaceArchiveError('The backup contains an unsafe archive path.');
  }
  return value;
}

function integerField(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new WorkspaceArchiveError(`Backup manifest field ${field} is invalid.`);
  return value;
}

export interface WorkspaceArchiveInspection {
  manifest: WorkspaceBackupManifest;
  sourceFormatVersion: 1 | 2;
  entries: number;
  uncompressedBytes: number;
  noteMarkdownBytes: number;
  attachmentBytes: number;
  files: Readonly<Record<string, Uint8Array>>;
}

export interface WorkspaceImportConflict {
  kind: 'notebook' | 'note' | 'attachment';
  sourceId: string;
  value: string;
  reason: 'duplicate_in_backup' | 'name_exists' | 'slug_exists' | 'import_identity_conflict';
}

export interface ExistingWorkspaceIdentity {
  notebookNames: string[];
  noteSlugs: string[];
}

/**
 * Derive a stable UUID for one logical item in one owner's backup. The
 * resulting UUID is never restored as the source item's identity; it is only
 * an import identity that makes retries converge on the same target record.
 */
export async function workspaceImportUuid(ownerId: string, backupId: string, kind: WorkspaceImportItemKind, sourceId: string): Promise<string> {
  const digest = await sha256Hex(`qnotes:workspace-import:${kind}:${ownerId}:${backupId}:${sourceId}`);
  return uuidFromHex(digest);
}

function uuidFromHex(digest: string): string {
  const hex = digest.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '8', 16) % 4] ?? '8';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function legacySafeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'note';
}

async function legacyBackupId(files: Readonly<Record<string, Uint8Array>>): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('qnotes:legacy-workspace-backup:v1');
  const entries = Object.keys(files).sort().map((path) => ({ path: encoder.encode(path), bytes: files[path] as Uint8Array }));
  const totalBytes = 16 + prefix.byteLength + entries.reduce((total, entry) => total + 16 + entry.path.byteLength + entry.bytes.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new WorkspaceArchiveError('The legacy backup is too large to identify safely.');
  const canonical = new Uint8Array(totalBytes);
  const view = new DataView(canonical.buffer);
  let offset = 0;
  view.setBigUint64(offset, BigInt(prefix.byteLength));
  offset += 8;
  canonical.set(prefix, offset);
  offset += prefix.byteLength;
  view.setBigUint64(offset, BigInt(entries.length));
  offset += 8;
  for (const entry of entries) {
    view.setBigUint64(offset, BigInt(entry.path.byteLength));
    offset += 8;
    canonical.set(entry.path, offset);
    offset += entry.path.byteLength;
    view.setBigUint64(offset, BigInt(entry.bytes.byteLength));
    offset += 8;
    canonical.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonical));
  return uuidFromHex(Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

export function safeImportFileName(value: string): string {
  const basename = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160);
  if (!safe) throw new WorkspaceArchiveError('The backup contains an invalid attachment file name.');
  return safe;
}

export async function validateWorkspaceContents(inspection: WorkspaceArchiveInspection): Promise<void> {
  for (const note of inspection.manifest.notes) {
    const file = inspection.files[note.markdownPath];
    if (!file) throw new WorkspaceArchiveError('The backup is missing a required Markdown file.');
    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(file);
    } catch {
      throw new WorkspaceArchiveError('The backup contains invalid UTF-8 Markdown.');
    }
    if (markdown.length > MAX_MARKDOWN_CODE_UNITS) throw new WorkspaceArchiveError('The backup contains an oversized note.');
    try {
      await parseMarkdown(markdown);
    } catch (error: unknown) {
      if (error instanceof MarkdownParseError) throw new WorkspaceArchiveError(error.message);
      throw error;
    }
    for (const attachment of note.attachments) safeImportFileName(attachment.originalFileName);
  }
}

export function workspaceImportConflicts(manifest: WorkspaceBackupManifest, existing: ExistingWorkspaceIdentity): WorkspaceImportConflict[] {
  const conflicts: WorkspaceImportConflict[] = [];
  const notebookNames = new Set(existing.notebookNames.map((name) => name.trim().toLowerCase()));
  const noteSlugs = new Set(existing.noteSlugs.map((slug) => slug.trim().toLowerCase()));
  const backupNotebookNames = new Set<string>();
  const backupNoteSlugs = new Set<string>();

  for (const notebook of manifest.notebooks) {
    const name = notebook.name.trim().toLowerCase();
    if (notebookNames.has(name)) conflicts.push({ kind: 'notebook', sourceId: notebook.id, value: notebook.name, reason: 'name_exists' });
    if (backupNotebookNames.has(name)) conflicts.push({ kind: 'notebook', sourceId: notebook.id, value: notebook.name, reason: 'duplicate_in_backup' });
    backupNotebookNames.add(name);
  }
  for (const note of manifest.notes) {
    const slug = note.slug.trim().toLowerCase();
    if (noteSlugs.has(slug)) conflicts.push({ kind: 'note', sourceId: note.id, value: note.slug, reason: 'slug_exists' });
    if (backupNoteSlugs.has(slug)) conflicts.push({ kind: 'note', sourceId: note.id, value: note.slug, reason: 'duplicate_in_backup' });
    backupNoteSlugs.add(slug);
  }
  return conflicts;
}

export async function inspectWorkspaceArchive(archive: Uint8Array, maxBytes: number, maxAttachmentBytes = maxBytes): Promise<WorkspaceArchiveInspection> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || archive.byteLength > maxBytes) throw new WorkspaceArchiveError('The backup archive exceeds the configured size limit.');
  let entries = 0;
  let uncompressedBytes = 0;
  const archivePaths = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter: (file) => {
        safeArchivePath(file.name);
        if (archivePaths.has(file.name)) throw new WorkspaceArchiveError('The backup contains a duplicate archive path.');
        archivePaths.add(file.name);
        entries += 1;
        if (entries > MAX_EXPORT_ENTRIES || !Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || file.originalSize > maxBytes || uncompressedBytes + file.originalSize > maxBytes) throw new WorkspaceArchiveError('The backup contains too many or too many uncompressed files.');
        uncompressedBytes += file.originalSize;
        return true;
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceArchiveError) throw error;
    throw new WorkspaceArchiveError('The backup archive is invalid or cannot be safely decompressed.');
  }
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new WorkspaceArchiveError('The backup manifest is missing.');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new WorkspaceArchiveError('The backup manifest is not valid JSON.');
  }
  const root = record(raw);
  let sourceFormatVersion: 1 | 2;
  let normalizedRoot: Record<string, unknown>;
  if (root.format === 'quadrate-notes-workspace' && root.formatVersion === 2 && isUUID(root.backupId)) {
    sourceFormatVersion = 2;
    normalizedRoot = root;
  } else if (root.format === undefined && root.formatVersion === undefined && Object.keys(root).sort().join(',') === 'exportedAt,notes' && Array.isArray(root.notes)) {
    if (root.notes.length > MAX_EXPORT_ENTRIES) throw new WorkspaceArchiveError('The legacy backup manifest contains too many records.');
    const legacyNotes = root.notes.map((value, index) => {
      const item = record(value);
      const id = stringField(item.id, `notes[${index}].id`, 64);
      const slug = stringField(item.slug, `notes[${index}].slug`, 80);
      if (!isUUID(id) || !SAFE_SLUG.test(slug)) throw new WorkspaceArchiveError('The legacy backup contains an invalid note identity.');
      const attachmentValues = item.attachments;
      if (!Array.isArray(item.tags) || !Array.isArray(attachmentValues)) throw new WorkspaceArchiveError('The legacy backup note must contain tags and attachments arrays.');
      const attachments = attachmentValues.map((attachmentValue, attachmentIndex) => {
        const attachment = record(attachmentValue);
        return {
          id: attachment.id,
          originalFileName: attachment.originalFileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          path: attachment.path,
        };
      });
      return {
        id,
        slug,
        title: item.title,
        tags: item.tags,
        notebookId: null,
        version: item.version,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        markdownPath: `notes/${legacySafeName(slug)}.md`,
        attachments,
      };
    });
    sourceFormatVersion = 1;
    normalizedRoot = {
      format: 'quadrate-notes-workspace',
      formatVersion: 2,
      backupId: await legacyBackupId(files),
      exportedAt: root.exportedAt,
      notebooks: [],
      notes: legacyNotes,
    };
  } else {
    throw new WorkspaceArchiveError('The backup manifest version is unsupported.');
  }
  if (!Array.isArray(normalizedRoot.notebooks) || !Array.isArray(normalizedRoot.notes)) throw new WorkspaceArchiveError('The backup manifest must contain notebooks and notes arrays.');
  const notebookValues = normalizedRoot.notebooks;
  const noteValues = normalizedRoot.notes;
  if (notebookValues.length + noteValues.length > MAX_EXPORT_ENTRIES) throw new WorkspaceArchiveError('The backup manifest contains too many records.');
  const notebookIds = new Set<string>();
  const notebooks = notebookValues.map((value, index) => {
    const item = record(value);
    const id = stringField(item.id, `notebooks[${index}].id`, 64);
    if (!isUUID(id) || notebookIds.has(id)) throw new WorkspaceArchiveError('The backup contains a duplicate notebook ID.');
    notebookIds.add(id);
    return { id, name: stringField(item.name, `notebooks[${index}].name`, 80).trim(), createdAt: stringField(item.createdAt, `notebooks[${index}].createdAt`, 64), updatedAt: stringField(item.updatedAt, `notebooks[${index}].updatedAt`, 64) };
  });
  const noteIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const paths = new Set<string>(['manifest.json']);
  let noteMarkdownBytes = 0;
  let attachmentBytes = 0;
  const notes = noteValues.map((value, index) => {
    const item = record(value);
    const id = stringField(item.id, `notes[${index}].id`, 64);
    if (!isUUID(id) || noteIds.has(id)) throw new WorkspaceArchiveError('The backup contains a duplicate note ID.');
    noteIds.add(id);
    const slug = stringField(item.slug, `notes[${index}].slug`, 80);
    const title = stringField(item.title, `notes[${index}].title`, 200).trim();
    if (!SAFE_SLUG.test(slug) || !title) throw new WorkspaceArchiveError('The backup contains an invalid note identity.');
    const notebookId = item.notebookId === null ? null : stringField(item.notebookId, `notes[${index}].notebookId`, 64);
    if (notebookId !== null && (!isUUID(notebookId) || !notebookIds.has(notebookId))) throw new WorkspaceArchiveError('The backup references an unknown notebook.');
    const markdownPath = safeArchivePath(item.markdownPath);
    if (!markdownPath.startsWith('notes/') || !markdownPath.endsWith('.md') || paths.has(markdownPath) || !files[markdownPath]) throw new WorkspaceArchiveError('The backup note Markdown path is invalid or missing.');
    paths.add(markdownPath);
    const markdownBytes = files[markdownPath]?.byteLength ?? 0;
    if (markdownBytes > maxBytes || markdownBytes > MAX_MARKDOWN_CODE_UNITS * 4) throw new WorkspaceArchiveError('The backup contains an oversized note.');
    noteMarkdownBytes += markdownBytes;
    const tagValues = Array.isArray(item.tags) ? item.tags : [];
    const tags = tagValues.map((tag) => stringField(tag, `notes[${index}].tags`, 64).trim().toLowerCase());
    if (tags.length > 50 || tags.some((tag) => !tag)) throw new WorkspaceArchiveError('The backup contains invalid note tags.');
    if (!Array.isArray(item.tags) || !Array.isArray(item.attachments)) throw new WorkspaceArchiveError('The backup note must contain tags and attachments arrays.');
    const attachmentValues = item.attachments;
    const noteAttachmentIds = new Set<string>();
    const attachments = attachmentValues.map((attachmentValue, attachmentIndex) => {
      const attachment = record(attachmentValue);
      const attachmentId = stringField(attachment.id, `notes[${index}].attachments[${attachmentIndex}].id`, 64);
      if (!isUUID(attachmentId) || noteAttachmentIds.has(attachmentId) || attachmentIds.has(attachmentId)) throw new WorkspaceArchiveError('The backup contains a duplicate attachment ID.');
      noteAttachmentIds.add(attachmentId);
      attachmentIds.add(attachmentId);
      const path = safeArchivePath(attachment.path);
      const sizeBytes = integerField(attachment.sizeBytes, `notes[${index}].attachments[${attachmentIndex}].sizeBytes`, maxBytes);
      if (sizeBytes > maxAttachmentBytes) throw new WorkspaceArchiveError('The backup contains an attachment above the configured attachment size limit.');
      if (!path.startsWith('attachments/') || paths.has(path) || !files[path] || files[path].byteLength !== sizeBytes) throw new WorkspaceArchiveError('The backup attachment bytes do not match its manifest.');
      paths.add(path);
      if (!MIME_TYPES.has(String(attachment.mimeType))) throw new WorkspaceArchiveError('The backup contains an unsupported attachment type.');
      attachmentBytes += sizeBytes;
      return { id: attachmentId, originalFileName: stringField(attachment.originalFileName, 'originalFileName', 255), mimeType: String(attachment.mimeType), sizeBytes, path };
    });
    const version = integerField(item.version, `notes[${index}].version`, Number.MAX_SAFE_INTEGER);
    if (version < 1) throw new WorkspaceArchiveError('The backup contains an invalid note version.');
    return { id, slug, title, tags, notebookId, version, createdAt: stringField(item.createdAt, `notes[${index}].createdAt`, 64), updatedAt: stringField(item.updatedAt, `notes[${index}].updatedAt`, 64), markdownPath, attachments };
  });
  for (const path of Object.keys(files)) if (!paths.has(path)) throw new WorkspaceArchiveError('The backup contains an unexpected archive entry.');
  if (notes.length + notes.reduce((count, note) => count + note.attachments.length, 0) + 1 !== entries) throw new WorkspaceArchiveError('The backup manifest does not account for every archive entry.');
  return { manifest: { format: 'quadrate-notes-workspace', formatVersion: 2, backupId: String(normalizedRoot.backupId), exportedAt: stringField(normalizedRoot.exportedAt, 'exportedAt', 64), notebooks, notes }, sourceFormatVersion, entries, uncompressedBytes, noteMarkdownBytes, attachmentBytes, files };
}
