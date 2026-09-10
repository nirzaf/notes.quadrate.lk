import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SIZE = 1000;
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function parseVector(value) {
  const text = Array.isArray(value) ? `[${value.join(',')}]` : String(value ?? '');
  const values = text.replace(/^\[|\]$/g, '').split(',').map(Number);
  if (values.length !== 384 || values.some((item) => !Number.isFinite(item))) throw new Error('Provider embedding is not a 384-dimensional vector.');
  const norm = Math.sqrt(values.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.01) throw new Error('Provider embedding is not normalized.');
  return text;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function requireUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) throw new Error(`${name} must be a UUID.`);
  return value;
}

function embeddingInputHash(document) {
  const input = [document.source_title, document.heading_path, document.content]
    .map((value) => typeof value === 'string' ? value.replace(/^ +| +$/g, '') : '')
    .filter(Boolean)
    .join('\n\n');
  return createHash('sha256').update(input).digest('hex');
}

function hasCurrentEmbeddingInput(document) {
  return typeof document.embedding_input_hash === 'string'
    && document.embedding_input_hash === embeddingInputHash(document);
}

async function readOwnerRows(db, table, columns, ownerId, applyFilters = (query) => query) {
  const rows = [];
  let offset = 0;
  for (;;) {
    let query = db.from(table)
      .select(columns)
      .eq('owner_id', ownerId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await applyFilters(query);
    if (error) throw new Error('Local recall fixture ' + table + ' read failed: ' + error.message);
    const page = Array.isArray(data) ? data : [];
    if (!page.length) return rows;
    rows.push(...page);
    offset += page.length;
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function main() {
  if (!process.argv.includes('--local-recall')) throw new Error('Refusing to measure outside the explicit --local-recall mode.');
  const local = JSON.parse(await readFile(join(root, '.tmp/local-env.json'), 'utf8'));
  if (!isLocalUrl(local.supabaseUrl) || !local.serviceRoleKey) throw new Error('Recall measurement requires the local Docker Supabase environment from `pnpm run local:env`.');

  const ownerId = requireUuid(argument('--owner-id'), '--owner-id');
  const k = Number(argument('--k') ?? 10);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error('--k must be an integer between 1 and 50.');

  const client = createClient(local.supabaseUrl, local.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = client.schema('notesdb');
  const [documentRows, noteRows, blockRows] = await Promise.all([
    readOwnerRows(db, 'search_documents', 'id,note_id,source_type,source_key,source_title,heading_path,content,embedding,embedding_mode,embedding_model,embedding_model_version,embedding_status,embedding_input_hash', ownerId, (query) => query.eq('embedding_status', 'ready').not('embedding', 'is', null)),
    readOwnerRows(db, 'notes', 'id,notebook_id,tags,deleted_at', ownerId, (query) => query.is('deleted_at', null)),
    readOwnerRows(db, 'note_blocks', 'id,note_id,block_key,language', ownerId),
  ]);


  const noteById = new Map(noteRows.map((note) => [note.id, note]));
  const blockLanguage = new Map(blockRows.map((block) => [`${block.note_id}:${block.block_key}`, String(block.language ?? '').toLowerCase()]));
  const providerRows = documentRows
    .filter((document) => document.embedding_mode === 'provider' && document.embedding_model === 'gte-small' && document.embedding_model_version === 'v2')
    .filter(hasCurrentEmbeddingInput)
    .map((document) => ({ ...document, note: noteById.get(document.note_id) }))
    .filter((document) => document.note && !document.note.deleted_at)
    .map((document) => ({ ...document, embedding: parseVector(document.embedding) }));
  if (!providerRows.length) {
    const syntheticCount = documentRows.filter((document) => document.embedding_mode === 'synthetic-test-v1').length;
    throw new Error(`No ready provider embeddings exist for owner ${ownerId}; found ${syntheticCount} synthetic rows. Run the probe with a local provider-backed embedding fixture.`);
  }

  const notebookGroups = new Map();
  for (const row of providerRows) {
    if (!row.note.notebook_id) continue;
    const group = notebookGroups.get(row.note.notebook_id) ?? [];
    group.push(row);
    notebookGroups.set(row.note.notebook_id, group);
  }
  const smallNotebook = [...notebookGroups.entries()]
    .filter(([, rows]) => rows.length <= 128)
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (!smallNotebook) throw new Error('The provider fixture has no small authorized notebook subset of 128 or fewer vectors.');
  if (providerRows.length <= 128) throw new Error(`The provider fixture has ${providerRows.length} vectors; at least 129 are required for the large HNSW subset.`);

  const allNotebookIds = [...new Set(providerRows.map((row) => row.note.notebook_id).filter(Boolean))];
  const allowUnfiled = providerRows.some((row) => !row.note.notebook_id);
  const tagGroups = new Map();
  for (const row of providerRows) {
    for (const tag of row.note.tags ?? []) {
      const group = tagGroups.get(tag) ?? [];
      group.push(row);
      tagGroups.set(tag, group);
    }
  }
  const selectiveTag = [...tagGroups.entries()]
    .filter(([, rows]) => rows.length <= 128)
    .sort((a, b) => a[1].length - b[1].length)[0];
  if (!selectiveTag) throw new Error('The provider fixture has no highly selective tag subset of 128 or fewer vectors.');

  const languageGroups = new Map();
  for (const row of providerRows) {
    if (!['copy_block', 'code_block'].includes(row.source_type)) continue;
    const language = blockLanguage.get(`${row.note_id}:${row.source_key}`);
    if (!language) continue;
    const group = languageGroups.get(language) ?? [];
    group.push(row);
    languageGroups.set(language, group);
  }
  const selectiveLanguage = [...languageGroups.entries()]
    .filter(([, rows]) => rows.length <= 128)
    .sort((a, b) => a[1].length - b[1].length)[0];

  const subsets = [
    { name: 'small-notebook', rows: smallNotebook[1], filters: {}, notebookIds: [smallNotebook[0]], allowUnfiled: false },
    { name: 'large-authorized', rows: providerRows, filters: {}, notebookIds: allNotebookIds, allowUnfiled },
    { name: 'selective-tag', rows: selectiveTag[1], filters: { tags: [selectiveTag[0]] }, notebookIds: allNotebookIds, allowUnfiled },
  ];
  if (selectiveLanguage) subsets.push({ name: 'selective-language', rows: selectiveLanguage[1], filters: { languages: [selectiveLanguage[0]] }, notebookIds: allNotebookIds, allowUnfiled });

  const measured = [];
  for (const subset of subsets) {
    const samples = subset.rows.slice(0, 3);
    const samplesMeasured = [];
    for (const sample of samples) {
      const { data, error } = await client.rpc('qnotes_measure_tenant_vector_recall', {
        p_owner_id: ownerId,
        p_embedding: sample.embedding,
        p_filters: subset.filters,
        p_notebook_ids: subset.notebookIds,
        p_allow_unfiled: subset.allowUnfiled,
        p_k: k,
      });
      if (error) throw new Error(`Recall probe failed for ${subset.name}: ${error.message}`);
      if (!data || !Array.isArray(data.exactIds) || !Array.isArray(data.annIds) || typeof data.recallAtK !== 'number') throw new Error(`Recall probe returned an invalid result for ${subset.name}.`);
      const allowedIds = new Set(subset.rows.map((row) => row.id));
      if ([...data.exactIds, ...data.annIds].some((id) => !allowedIds.has(id))) throw new Error(`Recall probe returned an out-of-scope document for ${subset.name}.`);
      if (!data.exactIds.length) throw new Error(`Recall probe exact oracle found no provider rows for ${subset.name}.`);
      samplesMeasured.push(data);
    }
    measured.push({
      name: subset.name,
      filters: subset.filters,
      authorizedDocuments: subset.rows.length,
      queries: samplesMeasured.length,
      recallAtK: percentile(samplesMeasured.map((result) => result.recallAtK), 0.5),
      exactMsP50: percentile(samplesMeasured.map((result) => Number(result.exactMs)), 0.5),
      exactMsP95: percentile(samplesMeasured.map((result) => Number(result.exactMs)), 0.95),
      annMsP50: percentile(samplesMeasured.map((result) => Number(result.annMs)), 0.5),
      annMsP95: percentile(samplesMeasured.map((result) => Number(result.annMs)), 0.95),
      configuration: samplesMeasured[0] ? {
        pgvectorVersion: samplesMeasured[0].pgvectorVersion,
        annConfiguration: samplesMeasured[0].annConfiguration,
        settings: samplesMeasured[0].settings,
      } : null,
    });
  }

  console.log(JSON.stringify({
    mode: 'local-tenant-vector-recall',
    ownerId,
    k,
    providerRows: providerRows.length,
    selectiveLanguage: selectiveLanguage?.[0] ?? null,
    subsets: measured,
  }, null, 2));
}

await main();
