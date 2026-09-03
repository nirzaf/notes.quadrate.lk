import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient } from '../_shared/database.ts';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION, createEmbedding, embeddingInput, embeddingInputHash } from './embedding.ts';

const queueName = 'note-embeddings';
const WORKER_CONCURRENCY = 3;

type EmbeddingJob = { searchDocumentId: string; ownerId: string; contentHash: string; embeddingInputHash?: string; embeddingModelVersion?: string };
type WorkerOutcome = 'completed' | 'skipped' | 'retried' | 'failed';

function validMessage(value: unknown): value is EmbeddingJob {
  return !!value && typeof value === 'object'
    && typeof (value as { searchDocumentId?: unknown }).searchDocumentId === 'string'
    && typeof (value as { ownerId?: unknown }).ownerId === 'string'
    && typeof (value as { contentHash?: unknown }).contentHash === 'string';
}

async function processMessage(message: { message_id: number; read_count: number; message: unknown }): Promise<WorkerOutcome> {
  if (!validMessage(message.message)) {
    await archiveQueueMessage(queueName, message.message_id);
    return 'failed';
  }
  const job = message.message;
  try {
    const { data: document, error } = await appDbClient
      .from('search_documents')
      .select('id, owner_id, content, source_title, heading_path, content_hash, embedding_input_hash, embedding_status, embedding_model, embedding_model_version')
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .maybeSingle();
    if (error) throw error;
    if (!document || document.content_hash !== job.contentHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const expectedInputHash = await embeddingInputHash(document);
    if (job.embeddingInputHash && job.embeddingInputHash !== expectedInputHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    if (
      document.embedding_status === 'ready'
      && document.embedding_model === EMBEDDING_MODEL
      && document.embedding_model_version === EMBEDDING_MODEL_VERSION
      && document.embedding_input_hash === expectedInputHash
    ) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }

    const vector = await createEmbedding(embeddingInput(document));
    const { data: current, error: currentError } = await appDbClient
      .from('search_documents')
      .select('content, source_title, heading_path, content_hash, embedding_input_hash')
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .maybeSingle();
    if (currentError) throw currentError;
    const currentInputHash = current ? await embeddingInputHash(current) : null;
    if (!current || current.content_hash !== job.contentHash || currentInputHash !== expectedInputHash || current.embedding_input_hash !== expectedInputHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const { error: updateError } = await appDbClient
      .from('search_documents')
      .update({
        embedding: vector,
        embedding_status: 'ready',
        embedding_model: EMBEDDING_MODEL,
        embedding_model_version: EMBEDDING_MODEL_VERSION,
        embedding_input_hash: expectedInputHash,
        embedding_queued_at: null,
        embedding_error: null,
      })
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .eq('content_hash', job.contentHash)
      .eq('embedding_input_hash', expectedInputHash);
    if (updateError) throw updateError;
    await deleteQueueMessage(queueName, message.message_id);
    return 'completed';
  } catch {
    if (message.read_count >= 5) {
      await appDbClient
        .from('search_documents')
        .update({ embedding_status: 'failed', embedding_error: 'EMBEDDING_FAILED' })
        .eq('id', job.searchDocumentId)
        .eq('owner_id', job.ownerId)
        .eq('content_hash', job.contentHash);
      await archiveQueueMessage(queueName, message.message_id);
      return 'failed';
    }
    return 'retried';
  }
}

async function processBounded(messages: Array<{ message_id: number; read_count: number; message: unknown }>): Promise<WorkerOutcome[]> {
  const results: WorkerOutcome[] = [];
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (nextIndex < messages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const message = messages[index];
      if (message) results[index] = await processMessage(message);
    }
  }
  const workerCount = Math.min(WORKER_CONCURRENCY, messages.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

async function processRequest(request: Request): Promise<Response> {
  if (request.headers.get('x-qnotes-worker-secret') !== Deno.env.get('QNOTES_INTERNAL_WORKER_SECRET')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const outcomes: WorkerOutcome[] = [];
  for (let batch = 0; batch < 4; batch += 1) {
    const messages = await readQueue(queueName, 120, 50);
    if (!messages.length) break;
    outcomes.push(...await processBounded(messages));
  }
  return Response.json({
    data: {
      completed: outcomes.filter((outcome) => outcome === 'completed').length,
      skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
      retried: outcomes.filter((outcome) => outcome === 'retried').length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
    },
  });
}

Deno.serve(processRequest);
