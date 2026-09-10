import { z, type ZodRawShape } from 'zod';

const id = z.string().min(1);
const date = z.string().min(1);
const sourceType = z.enum(['note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk']);

export const MCP_CONTRACT_VERSION = '1';

export function strictInput<T extends ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

const searchResult = z.object({
  id,
  documentId: id.optional(),
  noteId: id,
  noteVersion: z.number().int().positive().optional(),
  noteSlug: z.string(),
  noteTitle: z.string(),
  sourceType,
  sourceId: id.nullable(),
  sourceKey: z.string(),
  sourceTitle: z.string(),
  headingPath: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
  keywordRank: z.number().int().nullable(),
  semanticRank: z.number().int().nullable(),
  copyable: z.boolean(),
  blockKey: z.string().nullable(),
  language: z.string().nullable(),
  attachmentId: id.nullable(),
  uri: z.string().optional(),
  tags: z.array(z.string()).optional(),
  notebookId: id.nullable().optional(),
  updatedAt: date.optional(),
  matchReasons: z.array(z.string()).optional(),
  scores: z.object({
    hybrid: z.number(),
    keywordRank: z.number().int().nullable(),
    semanticRank: z.number().int().nullable(),
  }).strict().optional(),
}).strict();

const searchTiming = z.object({
  embeddingMs: z.number().nonnegative(),
  retrievalMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  metadataMs: z.number().nonnegative().optional(),
  freshnessMs: z.number().nonnegative().optional(),
  serializationMs: z.number().nonnegative().optional(),
}).strict();

const searchIndex = z.object({
  model: z.string(),
  pendingDocuments: z.number().int().nonnegative(),
  failedDocuments: z.number().int().nonnegative(),
  oldestPendingAgeSeconds: z.number().nonnegative().nullable(),
  fresh: z.boolean(),
  freshness: z.enum(['fresh', 'stale', 'unknown']).optional(),
}).strict();

export const searchResponseSchema = z.object({
  items: z.array(searchResult),
  queryId: id,
  modeUsed: z.enum(['keyword', 'semantic', 'hybrid']),
  degraded: z.boolean(),
  degradedReason: z.enum(['QUERY_EMBEDDING_UNAVAILABLE', 'SEMANTIC_SEARCH_UNAVAILABLE', 'LOCAL_FALLBACK']).optional(),
  timing: searchTiming,
  index: searchIndex.optional(),
  nextCursor: z.string().nullable().optional(),
}).strict();

const contextSource = z.object({
  documentId: id,
  noteId: id,
  noteVersion: z.number().int().positive(),
  sourceType,
  sourceId: id.nullable(),
  sourceKey: z.string(),
  sourceTitle: z.string(),
  headingPath: z.string().nullable(),
  attachmentId: id.nullable(),
  pageNumber: z.number().int().positive().nullable(),
  content: z.string(),
  sourceHash: z.string(),
  truncated: z.boolean(),
}).strict();

export const searchContextSchema = z.object({
  noteId: id,
  noteVersion: z.number().int().positive(),
  documentId: id,
  uri: z.string(),
  title: z.string(),
  headingPath: z.string().nullable(),
  content: z.string(),
  previous: z.array(z.string()),
  next: z.array(z.string()),
  updatedAt: date,
  sourceType,
  sourceId: id.nullable().optional(),
  sourceKey: z.string().optional(),
  sourceTitle: z.string().optional(),
  attachmentId: id.nullable().optional(),
  pageNumber: z.number().int().positive().nullable().optional(),
  sourceHash: z.string().optional(),
  truncated: z.boolean().optional(),
  tokenBudget: z.object({ max: z.number().int().positive(), used: z.number().int().nonnegative(), unit: z.literal('approximate_tokens') }).strict().optional(),
  continuation: z.object({ cursor: z.string(), noteVersion: z.number().int().positive(), sourceHash: z.string(), nextOffset: z.number().int().nonnegative() }).strict().optional(),
  previousSources: z.array(contextSource).optional(),
  nextSources: z.array(contextSource).optional(),
}).strict();

export const noteBlockSchema = z.object({
  id,
  noteId: id,
  blockKey: z.string(),
  blockType: z.enum(['copy', 'code', 'prompt', 'command', 'sql', 'json', 'yaml', 'env', 'url', 'quote', 'checklist']),
  title: z.string().nullable(),
  language: z.string().nullable(),
  content: z.string(),
  position: z.number().int().nonnegative(),
  copyable: z.literal(true),
  contentHash: z.string(),
}).strict();

export const notebookListSchema = z.object({
  items: z.array(z.object({ id, name: z.string(), createdAt: date, updatedAt: date }).strict()),
}).strict();

export const publicSharedNoteSchema = z.object({ title: z.string(), contentMarkdown: z.string(), updatedAt: date }).strict();
export const publicShareSchema = z.object({ url: z.string().url(), noteId: id, expiresAt: date }).strict();

const acknowledgment = {
  noteId: id,
  title: z.string(),
  resultingVersion: z.number().int().positive(),
  mutationId: z.string().uuid(),
  uri: z.string().startsWith('qnotes://notes/'),
};
export const captureAcknowledgmentSchema = z.object({ ...acknowledgment, outcome: z.enum(['created', 'idempotent', 'deduplicated']) }).strict();
export const mutationAcknowledgmentSchema = z.object({ ...acknowledgment, outcome: z.enum(['applied', 'idempotent']) }).strict();

const vaultProject = z.object({ id, slug: z.string(), name: z.string(), description: z.string().nullable(), createdAt: date, updatedAt: date, archivedAt: date.nullable() }).strict();
const vaultEnvironment = z.object({ id, projectId: id, slug: z.string(), name: z.string(), description: z.string().nullable(), createdAt: date, updatedAt: date, archivedAt: date.nullable() }).strict();
const vaultSecret = z.object({ id, projectId: id, environmentId: id, name: z.string(), description: z.string().nullable(), version: z.number().int().positive(), createdAt: date, updatedAt: date, rotatedAt: date.nullable(), deletedAt: date.nullable() }).strict();
export const vaultProjectsSchema = z.object({ items: z.array(vaultProject) }).strict();
export const vaultEnvironmentsSchema = z.object({ items: z.array(vaultEnvironment) }).strict();
export const vaultSecretsSchema = z.object({ items: z.array(vaultSecret) }).strict();
export const vaultSecretSchema = z.object({ secretId: id, project: z.string(), environment: z.string(), name: z.string(), value: z.string(), version: z.number().int().positive(), updatedAt: date }).strict();
export const vaultSecretBatchSchema = z.object({ items: z.array(vaultSecretSchema) }).strict();
export const vaultMetadataSchema = vaultSecret;
