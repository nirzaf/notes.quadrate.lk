import { embeddingDocumentFromRow } from './adapter.ts';
import { embeddingInputHash } from './embedding.ts';

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.test('maps a snake_case search document row to the SQL-equivalent embedding input', async () => {
  const row = {
    source_title: '  Embedding Worker  ',
    heading_path: '  Search > Hashes  ',
    content: '  preserve the exact body  ',
  };
  const document = embeddingDocumentFromRow(row);
  const sqlEquivalentInput = 'Embedding Worker\n\nSearch > Hashes\n\npreserve the exact body';

  assertEquals(
    await embeddingInputHash(document),
    await sha256Hex(sqlEquivalentInput),
    'snake_case row hash must include title, heading path, and content',
  );
});
