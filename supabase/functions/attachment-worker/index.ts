import { sha256Hex } from '@qnotes/markdown';
import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { extractAttachment, attachmentParagraphs } from './extract.ts';

const queueName = 'attachment-processing';
const WORKER_CONCURRENCY = 3;
const BATCH_SIZE = 5;
const MAX_BATCHES_PER_REQUEST = 4;

function validMessage(value: unknown): value is { attachmentId: string; ownerId: string } {
  return !!value && typeof value === 'object'
    && typeof (value as { attachmentId?: unknown }).attachmentId === 'string'
    && typeof (value as { ownerId?: unknown }).ownerId === 'string';
}

type AttachmentOutcome = 'completed' | 'skipped' | 'retried' | 'failed';

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
    const { error: processingError } = await appDbClient.from('attachments').update({ extraction_status: 'processing', extraction_error: null }).eq('id', job.attachmentId).eq('owner_id', job.ownerId);
    if (processingError) throw processingError;
    const { data: file, error: storageError } = await serviceClient.storage.from(attachment.bucket).download(attachment.object_path);
    if (storageError || !file) throw storageError ?? new Error('Attachment object unavailable.');
    const bytes = new Uint8Array(await file.arrayBuffer());
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
      for (const content of attachmentParagraphs(pages[pageIndex] ?? '')) {
        const contentHash = await sha256Hex(`attachment_chunk\0${pageNumber}\0${content}`);
        const baseKey = `attachment:${job.attachmentId}:page:${pageNumber}:${contentHash.slice(0, 16)}`;
        const occurrence = keyOccurrences.get(baseKey) ?? 0;
        keyOccurrences.set(baseKey, occurrence + 1);
        documents.push({
          sourceKey: occurrence ? `${baseKey}:${occurrence}` : baseKey,
          sourceTitle: isPdf ? `${attachment.original_file_name} — page ${pageNumber}` : attachment.original_file_name,
          headingPath: isPdf ? `Page ${pageNumber}` : null,
          content,
          contentHash,
          position,
          sourceId: job.attachmentId,
          pageNumber: isPdf ? pageNumber : null,
        });
        position += 1;
      }
    }
    if (!documents.length) throw new Error('NO_EXTRACTABLE_TEXT');
    const checksum = await sha256Bytes(bytes);
    const { error: completeError } = await serviceClient.rpc('qnotes_complete_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_checksum_sha256: checksum, p_documents: documents });
    if (completeError) throw completeError;
    await deleteQueueMessage(queueName, message.message_id);
    return 'completed';
  } catch {
    if (message.read_count >= 5) {
      await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'failed', p_error: 'ATTACHMENT_PROCESSING_FAILED' });
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
  for (let batch = 0; batch < MAX_BATCHES_PER_REQUEST; batch += 1) {
    const messages = await readQueue(queueName, 120, BATCH_SIZE);
    if (!messages.length) break;
    outcomes.push(...await processBounded(messages));
  }
  const count = (outcome: AttachmentOutcome) => outcomes.filter((item) => item === outcome).length;
  return Response.json({ data: { completed: count('completed'), skipped: count('skipped'), retried: count('retried'), failed: count('failed') } });
}

Deno.serve(processRequest);

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
