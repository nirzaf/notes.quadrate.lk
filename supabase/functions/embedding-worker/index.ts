import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { createEmbedding } from './embedding.ts';

const queueName = 'note-embeddings';

function validMessage(value: unknown): value is { searchDocumentId: string; ownerId: string; contentHash: string } {
  return !!value && typeof value === 'object'
    && typeof (value as { searchDocumentId?: unknown }).searchDocumentId === 'string'
    && typeof (value as { ownerId?: unknown }).ownerId === 'string'
    && typeof (value as { contentHash?: unknown }).contentHash === 'string';
}

async function processRequest(request: Request): Promise<Response> {
  if (request.headers.get('x-qnotes-worker-secret') !== Deno.env.get('QNOTES_INTERNAL_WORKER_SECRET')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const messages = await readQueue(queueName, 60, 10);
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
      const { data: document, error } = await appDbClient.from('search_documents').select('id, owner_id, content, content_hash, embedding_status').eq('id', job.searchDocumentId).eq('owner_id', job.ownerId).maybeSingle();
      if (error) throw error;
      if (!document || document.content_hash !== job.contentHash) {
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
      }
      if (document.embedding_status === 'ready') {
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
      }
      const vector = await createEmbedding(document.content);
      const { data: current, error: currentError } = await appDbClient.from('search_documents').select('content_hash').eq('id', job.searchDocumentId).maybeSingle();
      if (currentError) throw currentError;
      if (!current || current.content_hash !== job.contentHash) {
        await deleteQueueMessage(queueName, message.message_id);
        skipped += 1;
        continue;
      }
      const { error: updateError } = await appDbClient.from('search_documents').update({ embedding: vector, embedding_status: 'ready', embedding_model: 'gte-small', embedding_error: null }).eq('id', job.searchDocumentId).eq('content_hash', job.contentHash);
      if (updateError) throw updateError;
      await deleteQueueMessage(queueName, message.message_id);
      completed += 1;
    } catch {
      if (message.read_count >= 5) {
        await appDbClient.from('search_documents').update({ embedding_status: 'failed', embedding_error: 'EMBEDDING_FAILED' }).eq('id', job.searchDocumentId).eq('content_hash', job.contentHash);
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
