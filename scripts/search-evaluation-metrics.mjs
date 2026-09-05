const METRIC_UNITS = new Set(['note', 'document']);

function resultKey(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  if (typeof item.key === 'string') return item.key;
  if (typeof item.noteSlug === 'string') return item.noteSlug;
  if (typeof item.slug === 'string') return item.slug;
  return null;
}

function resultNoteId(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.noteId === 'string') return item.noteId;
  if (typeof item.note_id === 'string') return item.note_id;
  return null;
}

function resultDocumentId(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.documentId === 'string') return item.documentId;
  if (typeof item.document_id === 'string') return item.document_id;
  if (typeof item.id === 'string') return item.id;
  return null;
}

function identityFor(item, metricUnit) {
  return metricUnit === 'document' ? item.documentId ?? item.key : item.noteId ?? item.key;
}

function rankingKeyFor(item, metricUnit) {
  return metricUnit === 'document' ? item.documentId ?? item.key : item.key;
}

function deduplicateByIdentity(items, metricUnit) {
  const seen = new Set();
  return items.filter((item) => {
    const identity = identityFor(item, metricUnit);
    if (identity === null) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function duplicateStats(items, metricUnit) {
  const seen = new Set();
  let identifiableRows = 0;
  let duplicateRows = 0;
  for (const item of items) {
    const identity = identityFor(item, metricUnit);
    if (identity === null) continue;
    identifiableRows += 1;
    if (seen.has(identity)) duplicateRows += 1;
    else seen.add(identity);
  }
  return { identifiableRows, duplicateRows };
}

function metricLabels(query, metricUnit) {
  const relevantField = metricUnit === 'document' ? (query.relevantDocuments ?? query.relevant) : query.relevant;
  const gradedField = metricUnit === 'document' ? (query.gradedDocuments ?? query.graded) : query.graded;
  return {
    relevant: new Set(Array.isArray(relevantField) ? relevantField : []),
    graded: gradedField && typeof gradedField === 'object' && !Array.isArray(gradedField) ? gradedField : {},
  };
}

export function calculateMetrics(queries, predictions, { metricUnit = 'note' } = {}) {
  if (!METRIC_UNITS.has(metricUnit)) throw new Error(`metricUnit must be one of: ${[...METRIC_UNITS].join(', ')}`);
  let recallTotal = 0;
  let reciprocalTotal = 0;
  let ndcgTotal = 0;
  let gradedQueries = 0;
  let noResultPredictions = 0;
  let noResultCorrect = 0;
  let duplicateNoteRows = 0;
  let noteRows = 0;
  let duplicateDocumentRows = 0;
  let documentRows = 0;
  let duplicateMetricRows = 0;
  const queryReports = [];

  for (const query of queries) {
    const rawItems = Array.isArray(predictions[query.id]) ? predictions[query.id] : [];
    const items = rawItems.map((item) => ({ key: resultKey(item), noteId: resultNoteId(item), documentId: resultDocumentId(item) }));
    const rankedItems = deduplicateByIdentity(items, metricUnit);
    const { relevant, graded } = metricLabels(query, metricUnit);
    const keys = rankedItems.map((item) => rankingKeyFor(item, metricUnit));
    const rawKeys = items.map((item) => rankingKeyFor(item, metricUnit));
    const noteStats = duplicateStats(items, 'note');
    const documentStats = duplicateStats(items, 'document');
    const metricStats = duplicateStats(items, metricUnit);
    duplicateNoteRows += noteStats.duplicateRows;
    noteRows += noteStats.identifiableRows;
    duplicateDocumentRows += documentStats.duplicateRows;
    documentRows += documentStats.identifiableRows;
    duplicateMetricRows += metricStats.duplicateRows;

    if (relevant.size) {
      gradedQueries += 1;
      recallTotal += keys.slice(0, 5).filter((item) => relevant.has(item)).length / relevant.size;
      const firstRelevant = keys.slice(0, 10).findIndex((item) => relevant.has(item));
      reciprocalTotal += firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;
      const dcg = keys.slice(0, 10).reduce((sum, item, index) => sum + (Number(graded[item] ?? 0) / Math.log2(index + 2)), 0);
      const ideal = Object.values(graded).sort((a, b) => Number(b) - Number(a)).slice(0, 10).reduce((sum, score, index) => sum + (Number(score) / Math.log2(index + 2)), 0);
      ndcgTotal += ideal ? dcg / ideal : 0;
    }
    if (!items.length) {
      noResultPredictions += 1;
      if (query.expectedNoResult) noResultCorrect += 1;
    }
    queryReports.push({
      id: query.id,
      returned: items.length,
      uniqueReturned: rankedItems.length,
      keys,
      rawKeys,
      duplicateNoteRows: noteStats.duplicateRows,
      duplicateDocumentRows: documentStats.duplicateRows,
    });
  }

  const denominator = gradedQueries || 1;
  return {
    queries: queries.length,
    gradedQueries,
    metricUnit,
    recallAt5: recallTotal / denominator,
    mrrAt10: reciprocalTotal / denominator,
    ndcgAt10: ndcgTotal / denominator,
    duplicateNoteRows,
    duplicateNoteRate: noteRows ? duplicateNoteRows / noteRows : 0,
    duplicateDocumentRows,
    duplicateDocumentRate: documentRows ? duplicateDocumentRows / documentRows : 0,
    duplicateMetricRows,
    noResultPrecision: noResultPredictions ? noResultCorrect / noResultPredictions : null,
    noResultQueries: noResultPredictions,
    queryReports,
  };
}
