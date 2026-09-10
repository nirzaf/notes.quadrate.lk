import { readFile } from 'node:fs/promises';

const report = await readFile(new URL('../docs/PRODUCTION_HARDENING_EVIDENCE.md', import.meta.url), 'utf8');
const requiredStories = Array.from({ length: 28 }, (_, index) => `US-${String(index + 1).padStart(2, '0')}`);
const missingStories = requiredStories.filter((story) => !report.includes(`| ${story} / [`));
const requiredPhrases = [
  'Self-hosted Supabase running through Docker',
  'no production secret movement',
  'isolation remains residual',
  'constrained adapter deferred',
  'Synthetic vectors are structural-test data',
  '| Encrypted backup restore |',
  '| Least-privilege credential rotation |',
  '| Audit-export recovery |',
  '| Incident disablement |',
];
const missingPhrases = requiredPhrases.filter((phrase) => !report.includes(phrase));

if (missingStories.length || missingPhrases.length) {
  throw new Error(`Hardening evidence is incomplete. Missing stories: ${missingStories.join(', ') || 'none'}. Missing required text: ${missingPhrases.join(', ') || 'none'}.`);
}

console.log(`Hardening evidence matrix is complete for ${requiredStories.length} stories; behavioral and staging gates remain separately recorded.`);
