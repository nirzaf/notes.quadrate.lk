import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkBodyParseError, readJsonBody } from '../search-benchmark-utils.mjs';
import { calculateMetrics } from '../search-evaluation-metrics.mjs';

test('reads a benchmark response body once and measures the parsed bytes', async () => {
  const payload = { data: { items: [{ documentId: 'document-1', noteId: 'note-1', text: 'π' }] } };
  const raw = JSON.stringify(payload);
  const response = new Response(raw, { headers: { 'content-type': 'application/json' } });
  const parsed = await readJsonBody(response, 'Search response');

  assert.equal(parsed.bytes, Buffer.byteLength(raw));
  assert.deepEqual(parsed.body, payload);
  assert.equal(response.bodyUsed, true);
  await assert.rejects(() => response.json());
});

test('fails visibly when a benchmark response is not JSON', async () => {
  await assert.rejects(
    () => readJsonBody(new Response('{not-json', { status: 502 }), 'Search response'),
    (error) => error instanceof BenchmarkBodyParseError && error.message === 'Search response returned malformed JSON (HTTP 502).',
  );
});

test('deduplicates note hits before ranking metrics and reports repeated rows', () => {
  const query = {
    id: 'rollback',
    relevant: ['rollback-note', 'runbook-note'],
    graded: { 'rollback-note': 3, 'runbook-note': 1 },
  };
  const predictions = {
    rollback: [
      { key: 'rollback-note', noteId: 'note-1', documentId: 'document-1' },
      { key: 'rollback-note', noteId: 'note-1', documentId: 'document-2' },
      { key: 'runbook-note', noteId: 'note-2', documentId: 'document-3' },
    ],
  };
  const metrics = calculateMetrics([query], predictions);

  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.mrrAt10, 1);
  assert.equal(metrics.ndcgAt10, 1);
  assert.equal(metrics.duplicateNoteRows, 1);
  assert.equal(metrics.duplicateNoteRate, 1 / 3);
  assert.deepEqual(metrics.queryReports[0], {
    id: 'rollback',
    returned: 3,
    uniqueReturned: 2,
    keys: ['rollback-note', 'runbook-note'],
    rawKeys: ['rollback-note', 'rollback-note', 'runbook-note'],
    duplicateNoteRows: 1,
    duplicateDocumentRows: 0,
  });
});

test('retains document-level ranking identity when requested', () => {
  const query = {
    id: 'documents',
    relevantDocuments: ['document-1', 'document-2', 'document-3'],
    gradedDocuments: { 'document-1': 3, 'document-2': 2, 'document-3': 1 },
  };
  const metrics = calculateMetrics([query], {
    documents: [
      { noteId: 'note-1', documentId: 'document-1' },
      { noteId: 'note-1', documentId: 'document-2' },
      { noteId: 'note-2', documentId: 'document-3' },
    ],
  }, { metricUnit: 'document' });

  assert.equal(metrics.metricUnit, 'document');
  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.queryReports[0].uniqueReturned, 3);
  assert.equal(metrics.duplicateNoteRows, 1);
  assert.equal(metrics.duplicateMetricRows, 0);
});
