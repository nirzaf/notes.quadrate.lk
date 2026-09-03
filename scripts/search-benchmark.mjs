const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const url = argument('--url', process.env.QNOTES_URL);
const token = argument('--token', process.env.QNOTES_TOKEN);
const sizes = argument('--sizes', '1000,10000,100000').split(',').map((value) => Number(value));
const queries = argument('--queries', 'rollback,token rotation,production deployment').split(',').map((value) => value.trim()).filter(Boolean);
if (!url) throw new Error('Set QNOTES_URL or pass --url.');

const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? null;
for (const corpusSize of sizes) {
  const timings = [];
  for (const query of queries) {
    const started = performance.now();
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/search`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, mode: 'keyword', limit: 20, maxPerNote: 2, filters: {} }),
    });
    if (!response.ok) throw new Error(`Search failed for corpus ${corpusSize}: HTTP ${response.status}`);
    await response.arrayBuffer();
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ corpusSize, queries: queries.length, p50Ms: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95), maxMs: timings.at(-1) ?? null }));
}
