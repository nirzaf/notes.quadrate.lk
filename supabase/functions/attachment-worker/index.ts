import { sha256Hex } from '@qnotes/markdown';
import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { extractAttachment, attachmentParagraphs } from './extract.ts';

const queueName = 'attachment-processing';

function validMessage(value: unknown): value is { attachmentId: string; ownerId: string } {
  return !!value && typeof value === 'object'
    && typeof (value as { attachmentId?: unknown }).attachmentId === 'string'
    && typeof (value as { ownerId?: unknown }).ownerId === 'string';
}

async function processRequest(request: Request): Promise<Response> {
  if (request.headers.get('x-qnotes-worker-secret') !== Deno.env.get('QNOTES_INTERNAL_WORKER_SECRET')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const messages = await readQueue(queueName, 120, 5);
  let completed = 0;
  let skipped = 0;
  let retried = 0;
  let failed = 0;
  for (const message of messages) {
    if (!validMessage(message.message)) {
      await archiveQueueMessage(queueName, message.message_id);
      failed += 1;
      continue;
    }
    const job = message.message;
    try {
      const { data: attachment, error } = await appDbClient.from('attachments').select('*').eq('id', job.attachmentId).eq('owner_id', job.ownerId).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      if (!attachment) {
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
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
        skipped += 1;
        continue;
      }
      if (!extracted.text) throw new Error(extracted.error ?? 'NO_EXTRACTABLE_TEXT');

      const isPdf = attachment.mime_type === 'application/pdf';
      const pages = extracted.pages.length ? extracted.pages : [extracted.text];
      const documents: Array<{ sourceKey: string; sourceTitle: string; headingPath: string | null; content: string; contentHash: string; position: number }> = [];
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
          });
          position += 1;
        }
      }
      if (!documents.length) throw new Error('NO_EXTRACTABLE_TEXT');
      const checksum = await sha256Bytes(bytes);
      const { error: completeError } = await serviceClient.rpc('qnotes_complete_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_checksum_sha256: checksum, p_documents: documents });
      if (completeError) throw completeError;
      await deleteQueueMessage(queueName, message.message_id);
      completed += 1;
    } catch {
      if (message.read_count >= 5) {
        await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'failed', p_error: 'ATTACHMENT_PROCESSING_FAILED' });
        await archiveQueueMessage(queueName, message.message_id);
        failed += 1;
      } else {
        retried += 1;
      }
    }
  }
  return Response.json({ data: { completed, skipped, retried, failed } });
}

Deno.serve(processRequest);

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
