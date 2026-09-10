import { archiveQueueMessage, deleteQueueMessage, readQueue } from '../_shared/queue.ts';
import { appDbClient } from '../_shared/database.ts';
import { embeddingDocumentFromRow } from './adapter.ts';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION, createEmbedding, embeddingInput, embeddingInputHash, resolveEmbeddingMode } from './embedding.ts';
import {
  boundProviderEmbedding,
  canStartWork,
  createWorkerBudget,
  isProviderEmbeddingTimeout,
  remainingWorkerBudgetMs,
  shouldStartBatch,
  WORKER_BATCH_SIZE,
  WORKER_VISIBILITY_LEASE_SECONDS,
  PROVIDER_EMBEDDING_TIMEOUT_MS,
  MAX_PROVIDER_ATTEMPTS,
  shouldTerminallyFail,
  type WorkerBudget,
} from './worker-budget.ts';

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

async function processMessage(message: { message_id: number; read_count: number; message: unknown }, budget: WorkerBudget): Promise<WorkerOutcome> {
  if (!validMessage(message.message)) {
    await archiveQueueMessage(queueName, message.message_id);
    return 'failed';
  }
  const job = message.message;
  let failureInputHash: string | null = null;
  let providerAttempt: number | null = null;
  let embeddingMode: string = 'provider';
  try {
    const { data: document, error } = await appDbClient
      .from('search_documents')
      .select('id, owner_id, content, source_title, heading_path, content_hash, embedding_input_hash, embedding_status, embedding_model, embedding_model_version, embedding_attempts, embedding_mode')
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .maybeSingle();
    if (error) throw error;
    if (!document || document.content_hash !== job.contentHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    if (job.embeddingModelVersion && job.embeddingModelVersion !== EMBEDDING_MODEL_VERSION) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const embeddingDocument = embeddingDocumentFromRow(document);
    const expectedInputHash = await embeddingInputHash(embeddingDocument);
    failureInputHash = expectedInputHash;
    if (job.embeddingInputHash && job.embeddingInputHash !== expectedInputHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    embeddingMode = resolveEmbeddingMode(Deno.env);
    if (
      document.embedding_status === 'ready'
      && document.embedding_model === EMBEDDING_MODEL
      && document.embedding_model_version === EMBEDDING_MODEL_VERSION
      && document.embedding_input_hash === expectedInputHash
      && document.embedding_mode === embeddingMode
    ) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }

    const modeMismatch = (document.embedding_status === 'ready' || document.embedding_status === 'pending')
      && document.embedding_mode !== embeddingMode;
    if (modeMismatch) {
      const { data: reset, error: resetError } = await appDbClient
        .from('search_documents')
        .update({
          embedding: null,
          embedding_status: 'pending',
          embedding_error: null,
          embedding_attempts: 0,
          embedding_mode: embeddingMode,
          embedding_queued_at: new Date().toISOString(),
        })
        .eq('id', job.searchDocumentId)
        .eq('owner_id', job.ownerId)
        .eq('content_hash', job.contentHash)
        .eq('embedding_input_hash', expectedInputHash)
        .in('embedding_status', ['ready', 'pending'])
        .eq('embedding_mode', document.embedding_mode)
        .select('id')
        .maybeSingle();
      if (resetError) throw resetError;
      if (!reset) {
        await deleteQueueMessage(queueName, message.message_id);
        return 'skipped';
      }
    }

    if (!canStartWork(budget, Date.now())) return 'retried';
    const remainingBudgetMs = remainingWorkerBudgetMs(budget, Date.now());
    if (!remainingBudgetMs) return 'retried';
    const expectedAttempt = modeMismatch ? 0 : Number(document.embedding_attempts ?? 0);
    const { data: claimed, error: claimError } = await appDbClient
      .from('search_documents')
      .update({
        embedding_status: 'pending',
        embedding_attempts: expectedAttempt + 1,
        embedding_mode: embeddingMode,
        embedding_queued_at: new Date().toISOString(),
      })
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .eq('content_hash', job.contentHash)
      .eq('embedding_input_hash', expectedInputHash)
      .in('embedding_status', ['pending', 'failed'])
      .eq('embedding_model', EMBEDDING_MODEL)
      .eq('embedding_model_version', EMBEDDING_MODEL_VERSION)
      .eq('embedding_attempts', expectedAttempt)
      .lt('embedding_attempts', MAX_PROVIDER_ATTEMPTS)
      .select('embedding_attempts')
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) {
      const { data: terminal, error: terminalError } = await appDbClient
        .from('search_documents')
        .update({ embedding_status: 'failed', embedding_error: 'EMBEDDING_FAILED', embedding_queued_at: null })
        .eq('id', job.searchDocumentId)
        .eq('owner_id', job.ownerId)
        .eq('content_hash', job.contentHash)
        .eq('embedding_input_hash', expectedInputHash)
        .eq('embedding_model', EMBEDDING_MODEL)
        .eq('embedding_model_version', EMBEDDING_MODEL_VERSION)
        .eq('embedding_mode', embeddingMode)
        .eq('embedding_attempts', MAX_PROVIDER_ATTEMPTS)
        .eq('embedding_status', 'pending')
        .lte('embedding_queued_at', new Date(Date.now() - WORKER_VISIBILITY_LEASE_SECONDS * 1000).toISOString())
        .select('id')
        .maybeSingle();
      if (terminalError) throw terminalError;
      await archiveQueueMessage(queueName, message.message_id);
      return terminal ? 'failed' : 'skipped';
    }
    providerAttempt = Number((claimed as { embedding_attempts?: unknown }).embedding_attempts);
    const vector = await boundProviderEmbedding(
      createEmbedding(embeddingInput(embeddingDocument)),
      Math.min(PROVIDER_EMBEDDING_TIMEOUT_MS, remainingBudgetMs),
    );
    const { data: current, error: currentError } = await appDbClient
      .from('search_documents')
      .select('content, source_title, heading_path, content_hash, embedding_input_hash, embedding_attempts, embedding_mode')
      .eq('id', job.searchDocumentId)
      .eq('owner_id', job.ownerId)
      .maybeSingle();
    if (currentError) throw currentError;
    const currentInputHash = current ? await embeddingInputHash(embeddingDocumentFromRow(current)) : null;
    if (!current || current.content_hash !== job.contentHash || currentInputHash !== expectedInputHash || current.embedding_input_hash !== expectedInputHash) {
      await deleteQueueMessage(queueName, message.message_id);
      return 'skipped';
    }
    const { data: updated, error: updateError } = await appDbClient
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
      .eq('embedding_input_hash', expectedInputHash)
      .eq('embedding_status', 'pending')
      .eq('embedding_model', EMBEDDING_MODEL)
      .eq('embedding_model_version', EMBEDDING_MODEL_VERSION)
      .eq('embedding_attempts', providerAttempt)
      .eq('embedding_mode', embeddingMode)
      .select('id')
      .maybeSingle();
    if (updateError) throw updateError;
    await deleteQueueMessage(queueName, message.message_id);
    return updated ? 'completed' : 'skipped';
  } catch (error) {
    const terminal = providerAttempt !== null && shouldTerminallyFail(providerAttempt);
    if (terminal) {
      const failed = await appDbClient
        .from('search_documents')
        .update({ embedding_status: 'failed', embedding_error: isProviderEmbeddingTimeout(error) ? 'EMBEDDING_PROVIDER_TIMEOUT' : 'EMBEDDING_FAILED' })
        .eq('id', job.searchDocumentId)
        .eq('owner_id', job.ownerId)
        .eq('content_hash', job.contentHash)
        .eq('embedding_input_hash', failureInputHash ?? job.embeddingInputHash ?? '')
        .eq('embedding_model', EMBEDDING_MODEL)
        .eq('embedding_model_version', EMBEDDING_MODEL_VERSION)
        .eq('embedding_attempts', providerAttempt)
        .eq('embedding_mode', embeddingMode)
        .eq('embedding_status', 'pending')
        .select('id')
        .maybeSingle();
      if (failed.error) throw failed.error;
      await archiveQueueMessage(queueName, message.message_id);
      return failed.data ? 'failed' : 'skipped';
    }
    if (isProviderEmbeddingTimeout(error)) return 'retried';
    return 'retried';
  }
}

async function processBounded(
  messages: Array<{ message_id: number; read_count: number; message: unknown }>,
  budget: WorkerBudget,
): Promise<WorkerOutcome[]> {
  const results: WorkerOutcome[] = [];
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (nextIndex < messages.length) {
      if (!canStartWork(budget, Date.now())) return;
      const index = nextIndex;
      nextIndex += 1;
      const message = messages[index];
      if (message) results[index] = await processMessage(message, budget);
    }
  }
  const workerCount = Math.min(WORKER_CONCURRENCY, messages.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results.filter((outcome): outcome is WorkerOutcome => outcome !== undefined);
}

async function processRequest(request: Request): Promise<Response> {
  if (request.headers.get('x-qnotes-worker-secret') !== Deno.env.get('QNOTES_INTERNAL_WORKER_SECRET')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // Reject a misconfigured synthetic mode before leasing any queue work.
  resolveEmbeddingMode(Deno.env);
  const budget = createWorkerBudget(Date.now());
  const outcomes: WorkerOutcome[] = [];
  for (let batch = 0; shouldStartBatch(batch, budget, Date.now()); batch += 1) {
    const messages = await readQueue(queueName, WORKER_VISIBILITY_LEASE_SECONDS, WORKER_BATCH_SIZE);
    if (!messages.length) break;
    outcomes.push(...await processBounded(messages, budget));
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
