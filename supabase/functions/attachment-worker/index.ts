import { sha256Hex, splitEmbeddingContent } from '@qnotes/markdown';
import { sha256Bytes, uniquePaths } from '../_shared/attachment-storage.ts';
import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { extractAttachment, attachmentParagraphs } from './extract.ts';

const queueName = 'attachment-processing';
const WORKER_CONCURRENCY = 3;
const BATCH_SIZE = 5;
const MAX_BATCHES_PER_REQUEST = 4;
const CLEANUP_BATCH_SIZE = 25;
const STALE_PROCESSING_AFTER = '15 minutes';
const STALE_PROCESSING_LIMIT = 100;

function validMessage(value: unknown): value is { attachmentId: string; ownerId: string } {
  return !!value && typeof value === 'object'
    && typeof (value as { attachmentId?: unknown }).attachmentId === 'string'
    && typeof (value as { ownerId?: unknown }).ownerId === 'string';
}

type AttachmentOutcome = 'completed' | 'skipped' | 'retried' | 'failed';

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function scheduleCleanupRetry(row: Record<string, unknown>): Promise<void> {
  const attempts = Math.min(Number(row.cleanup_attempts ?? 0) + 1, 31);
  const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
  await appDbClient.from('attachments').update({ cleanup_attempts: attempts, cleanup_next_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), extraction_error: 'ATTACHMENT_CLEANUP_RETRY' }).eq('id', String(row.id)).eq('extraction_status', 'deleting');
}

async function cleanupAttachmentObjects(): Promise<void> {
  const now = new Date().toISOString();
  const expired = await appDbClient.from('attachments').select('id, owner_id').eq('extraction_status', 'pending_upload').is('deleted_at', null).not('staging_object_path', 'is', null).lte('staging_expires_at', now).limit(CLEANUP_BATCH_SIZE);
  if (expired.error) throw expired.error;
  for (const row of expired.data ?? []) {
    const requested = await serviceClient.rpc('qnotes_request_attachment_deletion', { p_owner_id: String(row.owner_id), p_attachment_id: String(row.id) });
    if (requested.error || objectRecord(requested.data).status !== 'deleting') throw requested.error ?? new Error('Attachment deletion transition was not recorded.');
  }

  const deleting = await appDbClient.from('attachments').select('id, owner_id, bucket, object_path, staging_object_path, cleanup_attempts').eq('extraction_status', 'deleting').lte('cleanup_next_at', now).limit(CLEANUP_BATCH_SIZE);
  if (deleting.error) throw deleting.error;
  for (const row of deleting.data ?? []) {
    const paths = uniquePaths(row.object_path, row.staging_object_path);
    const removed = paths.length ? await serviceClient.storage.from(String(row.bucket)).remove(paths) : { error: null };
    if (removed.error) {
      await scheduleCleanupRetry(row as Record<string, unknown>);
      continue;
    }
    const completed = await serviceClient.rpc('qnotes_complete_attachment_deletion', { p_owner_id: String(row.owner_id), p_attachment_id: String(row.id) });
    if (completed.error || objectRecord(completed.data).status !== 'ok') await scheduleCleanupRetry(row as Record<string, unknown>);
  }

  const staging = await appDbClient.from('attachments').select('id, bucket, staging_object_path').not('staging_object_path', 'is', null).neq('extraction_status', 'deleting').neq('extraction_status', 'deleted').neq('extraction_status', 'verifying').lte('staging_expires_at', now).limit(CLEANUP_BATCH_SIZE);
  if (staging.error) throw staging.error;
  for (const row of staging.data ?? []) {
    const path = String(row.staging_object_path ?? '');
    if (!path) continue;
    const removed = await serviceClient.storage.from(String(row.bucket)).remove([path]);
    if (removed.error) continue;
    await appDbClient.from('attachments').update({ staging_object_path: null, staging_expires_at: null, cleanup_attempts: 0, cleanup_next_at: new Date().toISOString() }).eq('id', String(row.id)).eq('staging_object_path', path);
  }
}

async function processMessage(message: { message_id: number; read_count: number; message: unknown }): Promise<AttachmentOutcome> {
  if (!validMessage(message.message)) {
    await archiveQueueMessage(queueName, message.message_id);
    return 'failed';
  }
  const job = message.message;
  try {
    const { data: attachment, error } = await appDbClient.from('attachments').select('*').eq('id', job.attachmentId).eq('owner_id', job.ownerId).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!attachment) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    if (String(attachment.extraction_status) !== 'queued') {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const claimed = await appDbClient.from('attachments').update({ extraction_status: 'processing', extraction_error: null }).eq('id', job.attachmentId).eq('owner_id', job.ownerId).eq('extraction_status', 'queued').is('deleted_at', null).select('object_generation').maybeSingle();
    if (claimed.error) throw claimed.error;
    if (!claimed.data) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const { data: file, error: storageError } = await serviceClient.storage.from(attachment.bucket).download(attachment.object_path);
    if (storageError || !file) throw storageError ?? new Error('Attachment object unavailable.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = await sha256Bytes(bytes);
    if (attachment.storage_mode === 'immutable' && (String(attachment.checksum_sha256 ?? '') !== checksum || !attachment.verified_at)) {
      const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'failed', p_error: 'ATTACHMENT_INTEGRITY_MISMATCH' });
      if (failed.error) throw failed.error;
      await archiveQueueMessage(queueName, message.message_id);
      return 'failed';
    }
    const extracted = await extractAttachment(bytes, attachment.mime_type);
    if (extracted.status === 'unsupported') {
      const { error: failedError } = await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'unsupported', p_error: extracted.error });
      if (failedError) throw failedError;
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    if (!extracted.text) throw new Error(extracted.error ?? 'NO_EXTRACTABLE_TEXT');

    const isPdf = attachment.mime_type === 'application/pdf';
    const pages = extracted.pages.length ? extracted.pages : [extracted.text];
    const documents: Array<{ sourceKey: string; sourceTitle: string; headingPath: string | null; content: string; contentHash: string; position: number; sourceId: string; pageNumber: number | null }> = [];
    const keyOccurrences = new Map<string, number>();
    let position = 0;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const pageNumber = pageIndex + 1;
      const sourceTitle = isPdf ? `${attachment.original_file_name} — page ${pageNumber}` : attachment.original_file_name;
      const headingPath = isPdf ? `Page ${pageNumber}` : null;
      for (const content of attachmentParagraphs(pages[pageIndex] ?? '')) {
        for (const safeContent of splitEmbeddingContent(content, sourceTitle, headingPath)) {
          const contentHash = await sha256Hex(`attachment_chunk\0${pageNumber}\0${safeContent}`);
          const baseKey = `attachment:${job.attachmentId}:page:${pageNumber}:${contentHash.slice(0, 16)}`;
          const occurrence = keyOccurrences.get(baseKey) ?? 0;
          keyOccurrences.set(baseKey, occurrence + 1);
          documents.push({
            sourceKey: occurrence ? `${baseKey}:${occurrence}` : baseKey,
            sourceTitle,
            headingPath,
            content: safeContent,
            contentHash,
            position,
            sourceId: job.attachmentId,
            pageNumber: isPdf ? pageNumber : null,
          });
          position += 1;
        }
      }
    }
    if (!documents.length) throw new Error('NO_EXTRACTABLE_TEXT');
    const completed = await serviceClient.rpc('qnotes_complete_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_generation: String(attachment.object_generation), p_checksum_sha256: checksum, p_documents: documents });
    if (completed.error) throw completed.error;
    const completion = objectRecord(completed.data);
    if (completion.status === 'not_found') {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    if (completion.status !== 'ok') {
      const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'failed', p_error: 'ATTACHMENT_INTEGRITY_MISMATCH' });
      if (failed.error) throw failed.error;
      await archiveQueueMessage(queueName, message.message_id);
      return 'failed';
    }
    await deleteQueueMessage(queueName, message.message_id);
    return 'completed';
  } catch {
    if (message.read_count >= 5) {
      const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'failed', p_error: 'ATTACHMENT_PROCESSING_FAILED' });
      if (failed.error) throw failed.error;
      await archiveQueueMessage(queueName, message.message_id);
      return 'failed';
    }
    return 'retried';
  }
}

async function processBounded(messages: Array<{ message_id: number; read_count: number; message: unknown }>): Promise<AttachmentOutcome[]> {
  const results: AttachmentOutcome[] = [];
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (nextIndex < messages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const message = messages[index];
      if (message) results[index] = await processMessage(message);
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKER_CONCURRENCY, messages.length) }, () => consume()));
  return results;
}

async function processRequest(request: Request): Promise<Response> {
  if (request.headers.get('x-qnotes-worker-secret') !== Deno.env.get('QNOTES_INTERNAL_WORKER_SECRET')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const outcomes: AttachmentOutcome[] = [];
  const { error: recoveryError } = await serviceClient.rpc('qnotes_requeue_stale_attachment_processing', { p_stale_after: STALE_PROCESSING_AFTER, p_limit: STALE_PROCESSING_LIMIT });
  if (recoveryError) throw recoveryError;
  try {
    await cleanupAttachmentObjects();
  } catch {
    // Cleanup is retried by the next bounded worker invocation.
  }
  for (let batch = 0; batch < MAX_BATCHES_PER_REQUEST; batch += 1) {
    const messages = await readQueue(queueName, 120, BATCH_SIZE);
    if (!messages.length) break;
    outcomes.push(...await processBounded(messages));
  }
  const count = (outcome: AttachmentOutcome) => outcomes.filter((item) => item === outcome).length;
  return Response.json({ data: { completed: count('completed'), skipped: count('skipped'), retried: count('retried'), failed: count('failed') } });
}

Deno.serve(processRequest);
