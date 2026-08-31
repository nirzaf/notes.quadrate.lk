import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, invokeWorker, localEnv, OTHER, signInPage, signInSession, poll } from './helpers';

function dataArray(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const value = (body as { data?: unknown }).data;
  return Array.isArray(value) ? value : [];
}

test('searches keyword, named blocks, semantic, hybrid, and enforces owner isolation', async ({ page }) => {
  const session = await signInSession();
  const marker = `keyword-${crypto.randomUUID().slice(0, 8)}`;
  const note = await createNoteApi(session.access_token, `Search fixture ${marker}`, `# Search fixture\n\nKeyword marker ${marker}.\n\n:::copy{id="search-block" title="Search Block" lang="bash" type="command"}\necho reusable-search-command\n:::\n`);

  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.fill(marker);
  const keywordResult = page.locator('.q-result').filter({ hasText: note.title }).first();
  await expect(keywordResult).toBeVisible({ timeout: 15_000 });
  await expect(keywordResult).toContainText(marker);

  await search.fill('search-block');
  const blockResult = page.locator('.q-result').filter({ hasText: 'copy_block' }).first();
  await expect(blockResult).toBeVisible({ timeout: 15_000 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
  await blockResult.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('echo reusable-search-command');

  await invokeWorker('embedding-worker');
  const semantic = await poll(async () => {
    const result = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=semantic`, session.access_token);
    return { response: result.response, rows: dataArray(result.body) };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id), 20_000);
  expect(semantic.response.status).toBe(200);

  const hybrid = await poll(async () => {
    const result = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=hybrid`, session.access_token);
    return { response: result.response, rows: dataArray(result.body) };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id), 20_000);
  expect(hybrid.response.status).toBe(200);

  const other = await signInSession(OTHER);
  const isolated = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=keyword`, other.access_token);
  expect(isolated.response.status).toBe(200);
  expect(dataArray(isolated.body)).toEqual([]);

  const env = await localEnv();
  expect(env.apiUrl).toContain('/functions/v1/qnotes-api');
});
