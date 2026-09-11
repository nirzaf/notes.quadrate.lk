import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const report = await readFile(resolve(repoRoot, 'docs/PRODUCTION_HARDENING_EVIDENCE.md'), 'utf8');
const requiredStories = Array.from({ length: 28 }, (_, index) => `US-${String(index + 1).padStart(2, '0')}`);
const missingStories = requiredStories.filter((story) => !report.includes(`| ${story} / [`));
const requiredPhrases = [
  'Self-hosted Supabase running through Docker',
  'no production secret movement',
  'Synthetic vectors are structural-test data',
];
const missingPhrases = requiredPhrases.filter((phrase) => !report.includes(phrase));
const sectionBetween = (startHeading, endHeading) => {
  const start = report.indexOf(startHeading);
  if (start < 0) return '';
  const end = endHeading ? report.indexOf(endHeading, start + startHeading.length) : -1;
  return report.slice(start, end < 0 ? report.length : end);
};

const residualRiskSection = sectionBetween('## Residual risks and unavailable evidence', '## Staging evidence template');
const requiredResidualPhrases = [
  'isolation remains residual',
  'constrained adapter deferred',
  'Production secret migration, revocation, permission cutover, deployment',
  'Real-provider recall and latency evidence requires a staging fixture',
  'Staging rehearsal evidence',
];
const residualRiskText = residualRiskSection.toLocaleLowerCase();
const missingResidualPhrases = requiredResidualPhrases.filter((phrase) => !residualRiskText.includes(phrase.toLocaleLowerCase()));

const matrixSection = sectionBetween('## Finding-to-evidence matrix', '## Behavioral authorization matrix');
const matrixRows = matrixSection
  .split(/\r?\n/)
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
  .filter((cells) => /^US-\d{2} \/ /.test(cells[0] ?? ''));
const incompleteMatrixRows = matrixRows
  .filter((cells) => cells.length !== 3 || cells.some((cell) => cell.length === 0))
  .map((cells) => cells[0] || '<missing story>');
const evidencePaths = [...new Set(
  matrixRows.flatMap((cells) => [...(cells[2] ?? '').matchAll(/`([^`]+)`/g)])
    .flatMap(([, value]) => value.split(';').map((part) => part.split(' — ')[0].trim()))
    .filter(Boolean),
)];
const missingEvidencePaths = [];
for (const path of evidencePaths) {
  try {
    const resolvedPath = await realpath(resolve(repoRoot, path));
    const relativePath = relative(repoRoot, resolvedPath);
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('evidence path escapes the repository');
    if (!(await stat(resolvedPath)).isFile()) throw new Error('evidence path is not a regular file');
  } catch {
    missingEvidencePaths.push(path);
  }
}

const requiredStagingRows = [
  'Encrypted backup restore',
  'Least-privilege credential rotation',
  'Audit-export recovery',
  'Incident disablement',
];
const stagingRows = sectionBetween('## Staging evidence template')
  .split(/\r?\n/)
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
  .filter((cells) => cells.length === 5 && cells[0] !== 'Rehearsal' && !cells.every((cell) => /^[-\s]+$/.test(cell)));
const missingStagingRows = requiredStagingRows.filter((name) => !stagingRows.some((cells) => cells[0] === name));
const gateSection = sectionBetween('## Gate record', '## Finding-to-evidence matrix');
const gateRows = gateSection
  .split(/\r?\n/)
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
  .filter((cells) => cells.length === 4 && cells[0] !== 'Gate' && !/^[-\s]+$/.test(cells[0]));
const requiredGateNames = [
  'Type contracts',
  'Unit behavior',
  'Edge behavior and parity',
  'Build',
  'Migrated SQL and RLS',
  'Search quality and plans',
  'Browser release smoke',
  'Vault readiness',
  'Workflow aggregation',
];
const missingGateNames = requiredGateNames.filter((name) => !gateRows.some((cells) => cells[0] === name));
const approvedGateResults = new Set([
  'passed', 'passed (path-gated)', 'unavailable', 'not run', 'not applicable', 'failed',
]);
const gateErrors = [];
for (const cells of gateRows) {
  const result = cells[2]?.replaceAll('`', '') ?? '';
  if (/TBD/i.test(cells[2] ?? '')) gateErrors.push(`gate '${cells[0]}' still has a TBD result`);
  if (result && !approvedGateResults.has(result)) gateErrors.push(`gate '${cells[0]}' has non-standard result '${result}'`);
}
const identitySection = sectionBetween('## Release identity', '## Gate record');
const shaMatch = identitySection.match(/Evidence target SHA.*?`([a-fA-F0-9]+)`/);
const evidenceShaValid = shaMatch && shaMatch[1].length === 40;

const nonUnavailableStagingRows = stagingRows
  .filter((cells) => cells[3].replaceAll('`', '') !== 'unavailable')
  .map((cells) => `${cells[0]}=${cells[3] || '<empty>'}`);

if (missingStories.length || incompleteMatrixRows.length || matrixRows.length !== requiredStories.length || missingPhrases.length || missingResidualPhrases.length || missingEvidencePaths.length || missingStagingRows.length || nonUnavailableStagingRows.length || missingGateNames.length || gateErrors.length || !evidenceShaValid) {
  throw new Error([
    `Missing stories: ${missingStories.join(', ') || 'none'}`,
    `Incomplete matrix rows: ${incompleteMatrixRows.join(', ') || 'none'}`,
    `Matrix row count: ${matrixRows.length}/${requiredStories.length}`,
    `missing required text: ${missingPhrases.join(', ') || 'none'}`,
    `missing residual-risk text: ${missingResidualPhrases.join(', ') || 'none'}`,
    `missing evidence paths: ${missingEvidencePaths.join(', ') || 'none'}`,
    `missing staging rows: ${missingStagingRows.join(', ') || 'none'}`,
    `non-unavailable staging results: ${nonUnavailableStagingRows.join(', ') || 'none'}`,
    `missing gate names: ${missingGateNames.join(', ') || 'none'}`,
    `gate errors: ${gateErrors.join('; ') || 'none'}`,
    `evidence target SHA: ${evidenceShaValid ? 'valid 40-character SHA' : 'missing or not a 40-character SHA'}`,
  ].join('. ') + '.');
}

console.log(`Hardening evidence matrix is complete for ${requiredStories.length} stories; cited paths, residual risks, gate results, evidence SHA, and unavailable staging results are verified.`);
