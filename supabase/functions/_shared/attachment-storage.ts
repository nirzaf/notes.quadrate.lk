import { serviceClient } from './database.ts';

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function uniquePaths(...paths: unknown[]): string[] {
  return paths.filter((path): path is string => typeof path === 'string' && path.length > 0).filter((path, index, all) => all.indexOf(path) === index);
}

export async function ensureFinalObject(bucket: string, path: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  const uploaded = await serviceClient.storage.from(bucket).upload(path, new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }), { contentType: mimeType, upsert: false });
  if (uploaded.error) {
    const existing = await serviceClient.storage.from(bucket).download(path);
    if (existing.error || !existing.data) throw new Error('FINAL_OBJECT_UNAVAILABLE');
    const existingBytes = new Uint8Array(await existing.data.arrayBuffer());
    if (!bytesEqual(existingBytes, bytes)) throw new Error('FINAL_OBJECT_CONFLICT');
  }
  const finalObject = await serviceClient.storage.from(bucket).download(path);
  if (finalObject.error || !finalObject.data) throw new Error('FINAL_OBJECT_UNAVAILABLE');
  const finalBytes = new Uint8Array(await finalObject.data.arrayBuffer());
  if (!bytesEqual(finalBytes, bytes)) throw new Error('FINAL_OBJECT_INTEGRITY_MISMATCH');
}

export async function removeAttachmentObjectsOrScheduleDeletion(
  ownerId: string,
  attachmentId: string,
  bucket: string,
  paths: string[],
): Promise<'removed' | 'scheduled'> {
  const pathsToRemove = uniquePaths(...paths);
  const removed = pathsToRemove.length ? await serviceClient.storage.from(bucket).remove(pathsToRemove) : { error: null };
  if (!removed.error) return 'removed';
  const requested = await serviceClient.rpc('qnotes_request_attachment_deletion', { p_owner_id: ownerId, p_attachment_id: attachmentId });
  if (requested.error) throw requested.error;
  return 'scheduled';
}
