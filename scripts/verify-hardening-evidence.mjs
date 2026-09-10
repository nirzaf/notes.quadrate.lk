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
const nonUnavailableStagingRows = stagingRows
  .filter((cells) => cells[3].replaceAll('`', '') !== 'unavailable')
  .map((cells) => `${cells[0]}=${cells[3] || '<empty>'}`);

if (missingStories.length || incompleteMatrixRows.length || matrixRows.length !== requiredStories.length || missingPhrases.length || missingResidualPhrases.length || missingEvidencePaths.length || missingStagingRows.length || nonUnavailableStagingRows.length) {
  throw new Error([
    `Missing stories: ${missingStories.join(', ') || 'none'}`,
    `Incomplete matrix rows: ${incompleteMatrixRows.join(', ') || 'none'}`,
    `Matrix row count: ${matrixRows.length}/${requiredStories.length}`,
    `missing required text: ${missingPhrases.join(', ') || 'none'}`,
    `missing residual-risk text: ${missingResidualPhrases.join(', ') || 'none'}`,
    `missing evidence paths: ${missingEvidencePaths.join(', ') || 'none'}`,
    `missing staging rows: ${missingStagingRows.join(', ') || 'none'}`,
    `non-unavailable staging results: ${nonUnavailableStagingRows.join(', ') || 'none'}`,
  ].join('. ') + '.');
}

console.log(`Hardening evidence matrix is complete for ${requiredStories.length} stories; cited paths, residual risks, and unavailable staging results are verified.`);
