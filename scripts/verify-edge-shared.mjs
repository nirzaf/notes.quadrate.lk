import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mappings = [
  ['packages/shared/src', 'supabase/functions/_shared/generated/shared'],
  ['packages/markdown/src', 'supabase/functions/_shared/generated/markdown'],
];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(relative(directory, path));
  }
  return files.sort();
}

for (const [sourceRelative, targetRelative] of mappings) {
  const source = join(root, sourceRelative);
  const target = join(root, targetRelative);
  const sourceFiles = await filesIn(source);
  const targetFiles = await filesIn(target);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    throw new Error(`Generated Edge path set differs for ${targetRelative}.`);
  }
  for (const file of sourceFiles) {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(join(source, file)), readFile(join(target, file))]);
    if (!sourceBytes.equals(targetBytes)) throw new Error(`Generated Edge file differs: ${targetRelative}/${file}`);
  }
}

console.log('Generated Edge shared sources are byte-identical.');
