import { cp, mkdir, readdir, rm } from 'node:fs/promises';
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
    else files.push(path);
  }
  return files;
}

for (const [sourceRelative, targetRelative] of mappings) {
  const source = join(root, sourceRelative);
  const target = join(root, targetRelative);
  const sourceFiles = (await filesIn(source)).sort();
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const sourceFile of sourceFiles) {
    const destination = join(target, relative(source, sourceFile));
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourceFile, destination);
  }
}

console.log('Edge shared sources synchronized.');
