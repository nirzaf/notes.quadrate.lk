import { sha256Hex } from '@qnotes/markdown';
import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { serviceClient } from '../_shared/database.ts';
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
      const { data: attachment, error } = await serviceClient.from('attachments').select('*').eq('id', job.attachmentId).eq('owner_id', job.ownerId).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      if (!attachment) {
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
      }
      await serviceClient.from('attachments').update({ extraction_status: 'processing', extraction_error: null }).eq('id', job.attachmentId).eq('owner_id', job.ownerId);
      const { data: file, error: storageError } = await serviceClient.storage.from(attachment.bucket).download(attachment.object_path);
      if (storageError || !file) throw storageError ?? new Error('Attachment object unavailable.');
      const extracted = await extractAttachment(new Uint8Array(await file.arrayBuffer()), attachment.mime_type);
      if (extracted.status === 'unsupported') {
        await serviceClient.rpc('qnotes_fail_attachment_processing', { p_owner_id: job.ownerId, p_attachment_id: job.attachmentId, p_status: 'unsupported', p_error: extracted.error });
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
      }
      if (!extracted.text) throw new Error(extracted.error ?? 'NO_EXTRACTABLE_TEXT');
      const paragraphs = attachmentParagraphs(extracted.text);
      const documents = [];
      for (let index = 0; index < paragraphs.length; index += 1) {
        const content = paragraphs[index]!;
        documents.push({ sourceKey: `attachment:${job.attachmentId}:${index}`, sourceTitle: attachment.original_file_name, headingPath: null, content, contentHash: await sha256Hex(`attachment_chunk\0\0${content}`), position: index });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const checksum = await sha256Hex(new TextDecoder().decode(bytes));
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
