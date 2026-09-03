import { readFile } from 'node:fs/promises';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fixturePath = argument('--fixtures') ?? new URL('../tests/search-evaluation-fixtures.json', import.meta.url);
const inputPath = argument('--results');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const predictions = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : fixture.predictions;

const at = (items, index) => items[index] ?? null;
let recallTotal = 0;
let reciprocalTotal = 0;
let ndcgTotal = 0;
let noResultPredictions = 0;
let noResultCorrect = 0;
let duplicateRows = 0;
let resultRows = 0;

for (const query of fixture.queries) {
  const items = Array.isArray(predictions[query.id]) ? predictions[query.id] : [];
  const relevant = new Set(query.relevant);
  recallTotal += relevant.size ? items.slice(0, 5).filter((item) => relevant.has(item)).length / relevant.size : 0;
  const firstRelevant = items.slice(0, 10).findIndex((item) => relevant.has(item));
  reciprocalTotal += firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;
  const dcg = items.slice(0, 10).reduce((sum, item, index) => sum + (Number(query.graded?.[item] ?? 0) / Math.log2(index + 2)), 0);
  const ideal = Object.values(query.graded ?? {}).sort((a, b) => b - a).slice(0, 10).reduce((sum, score, index) => sum + (Number(score) / Math.log2(index + 2)), 0);
  ndcgTotal += ideal ? dcg / ideal : 0;
  if (!items.length) {
    noResultPredictions += 1;
    if (query.expectedNoResult) noResultCorrect += 1;
  }
  resultRows += items.length;
  duplicateRows += items.length - new Set(items).size;
}

const count = fixture.queries.length || 1;
const output = {
  queries: fixture.queries.length,
  recallAt5: recallTotal / count,
  mrrAt10: reciprocalTotal / count,
  ndcgAt10: ndcgTotal / count,
  duplicateRate: resultRows ? duplicateRows / resultRows : 0,
  noResultPrecision: noResultPredictions ? noResultCorrect / noResultPredictions : null,
};
console.log(JSON.stringify(output, null, 2));
