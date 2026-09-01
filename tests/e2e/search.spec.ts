import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, invokeWorker, localEnv, OTHER, signInPage, signInSession, poll } from './helpers';

function dataArray(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const value = (body as { data?: unknown }).data;
  return Array.isArray(value) ? value : [];
}

test('filters notes by title and partial body matches, then covers semantic, hybrid, and isolation', async ({ page }) => {
  const session = await signInSession();
  const marker = `keyword-${crypto.randomUUID().slice(0, 8)}`;
  const bodyMarker = `body-only-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const note = await createNoteApi(session.access_token, `Search fixture ${marker}`, `# Search fixture\n\nKeyword marker ${marker}.\n\nPartial body marker ${bodyMarker}.\n\n:::copy{id="search-block" title="Search Block" lang="bash" type="command"}\necho reusable-search-command\n:::\n`);

  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.fill(marker);
  const matchingNotes = page.locator('section.q-card').filter({ has: page.getByRole('heading', { name: 'Matching notes' }) }).locator('.q-note-item');
  const keywordNote = matchingNotes.filter({ hasText: note.title }).first();
  await expect(keywordNote).toBeVisible({ timeout: 15_000 });
  await expect(keywordNote).toContainText(marker);
  await expect(page.locator('.q-result')).toHaveCount(0);

  await search.fill(bodyMarker.slice(0, -4));
  const bodyNote = matchingNotes.filter({ hasText: note.title }).first();
  await expect(bodyNote).toBeVisible({ timeout: 15_000 });
  await expect(bodyNote).toContainText(bodyMarker);

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
