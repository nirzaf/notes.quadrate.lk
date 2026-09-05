import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, invokeWorker, localEnv, OTHER, signInPage, signInSession, poll, searchItems } from './helpers';

test('filters notes by title and partial body matches, then covers semantic, hybrid, and isolation', async ({ page }) => {
  const session = await signInSession();
  const marker = `keyword-${crypto.randomUUID().slice(0, 8)}`;
  const bodyMarker = `body-only-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const note = await createNoteApi(session.access_token, `Search fixture ${marker}`, `# Search fixture\n\nKeyword marker ${marker}.\n\nPartial body marker ${bodyMarker}.\n\n:::copy{id="search-block" title="Search Block" lang="bash" type="command"}\necho reusable-search-command\n:::\n`);

  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.fill(marker);
  const matchingResults = page.getByRole('list', { name: 'Matched search results' });
  const keywordNote = matchingResults.getByRole('listitem').filter({ hasText: note.title }).first();
  await expect(keywordNote).toBeVisible({ timeout: 15_000 });
  await expect(keywordNote).toContainText(marker);
  await expect(page.locator('.q-result')).toHaveCount(0);

  await search.fill(bodyMarker.slice(0, -4));
  const bodyNote = matchingResults.getByRole('listitem').filter({ hasText: note.title }).first();
  await expect(bodyNote).toBeVisible({ timeout: 15_000 });
  await expect(bodyNote).toContainText(bodyMarker);

  await invokeWorker('embedding-worker');
  const semantic = await poll(async () => {
    const result = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=semantic`, session.access_token);
    return { response: result.response, rows: searchItems(result.body) };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id), 20_000);
  expect(semantic.response.status).toBe(200);
  expect(semantic.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id)).toBe(true);

  const hybrid = await poll(async () => {
    const result = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=hybrid`, session.access_token);
    return { response: result.response, rows: searchItems(result.body) };
  }, (result) => result.response.ok && result.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id), 20_000);
  expect(hybrid.response.status).toBe(200);
  expect(hybrid.rows.some((row) => row && typeof row === 'object' && (row as { noteId?: unknown }).noteId === note.id)).toBe(true);
  const other = await signInSession(OTHER);
  const isolated = await apiJson(`/api/search?q=${encodeURIComponent(marker)}&mode=keyword`, other.access_token);
  expect(isolated.response.status).toBe(200);
  expect(searchItems(isolated.body)).toEqual([]);

  const env = await localEnv();
  expect(env.apiUrl).toContain('/functions/v1/qnotes-api');
});

test('paginates ranked results and preserves the exact result context in navigation', async ({ page }) => {
  const session = await signInSession();
  const marker = `paged-search-${crypto.randomUUID().slice(0, 8)}`;
  const notes = await Promise.all(Array.from({ length: 21 }, (_, index) => createNoteApi(session.access_token, `${marker} note ${index + 1}`, `# Section ${index + 1}\n\n${marker} searchable context.`)));
  await signInPage(page);
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.fill(marker);
  const results = page.getByRole('list', { name: 'Matched search results' });
  await expect(results.getByRole('listitem')).toHaveCount(20, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Load more results' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more results' }).click();
  await expect(results.getByRole('listitem')).toHaveCount(21, { timeout: 15_000 });

  const target = results.getByRole('listitem').filter({ hasText: notes[0]!.title }).first();
  await target.getByRole('button', { name: 'Open matching section' }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+\?/);
  const noteUrl = new URL(page.url());
  expect(noteUrl.searchParams.get('q')).toBe(marker);
  expect(noteUrl.searchParams.get('documentId')).toBeTruthy();
  await expect(page.getByRole('link', { name: /Back to search results/ })).toBeVisible();
  await page.getByRole('link', { name: /Back to search results/ }).click();
  await expect(page).toHaveURL(/\/\?q=/);
  expect(new URL(page.url()).searchParams.get('q')).toBe(marker);
});
