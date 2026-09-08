import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, expectPreviewMode, signInPage, signInSession } from './helpers';

test('creates notebooks, moves notes, filters the sidebar, and keeps note actions at the top', async ({ page }) => {
  await signInPage(page);
  const session = await signInSession();
  await createNoteApi(session.access_token, 'Notebook sidebar test', 'A note to organize.');
  await page.reload();

  await expect(page.locator('.q-note-items')).toHaveCSS('overflow-y', 'auto');
  await page.getByRole('button', { name: 'Create a notebook' }).click();
  await page.getByRole('textbox', { name: 'New notebook' }).fill('Operations');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Notebook “Operations” created.')).toBeVisible();

  const notebooksResponse = await apiJson('/api/notebooks', session.access_token);
  const notebook = (notebooksResponse.body as { data: { items: Array<{ id: string; name: string }> } }).data.items.find((item) => item.name === 'Operations');
  expect(notebook).toBeTruthy();

  await page.locator('.q-note-items .q-note-item').filter({ hasText: 'Notebook sidebar test' }).click();
  await expectPreviewMode(page);
  await expect(page.getByRole('button', { name: 'Copy Markdown' })).toBeVisible();
  await expect(page.locator('.q-editor-controls').getByRole('button', { name: 'Copy Markdown' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Notebook' }).selectOption(notebook!.id);
  await expect(page.getByText('Note moved to notebook.')).toBeVisible();

  await page.getByRole('link', { name: 'Quadrate Notes home' }).click();
  const notebookButton = page.locator('.q-notebook-item').filter({ hasText: 'Operations' });
  await notebookButton.click();
  await expect(page.locator('.q-note-items .q-note-item')).toHaveCount(1);
  await expect(page.locator('.q-note-items .q-note-item')).toContainText('Notebook sidebar test');
});

test('filters all home cards from the selected notebook', async ({ page }) => {
  await signInPage(page);
  const session = await signInSession();
  const notes = await Promise.all(Array.from({ length: 9 }, (_, index) => createNoteApi(session.access_token, `Notebook filter ${index + 1}`, `Filter fixture ${index + 1}.`)));
  const notebookResponse = await apiJson('/api/notebooks', session.access_token, { method: 'POST', body: JSON.stringify({ name: 'Home filter test' }) });
  expect(notebookResponse.response.ok).toBe(true);
  const notebook = (notebookResponse.body as { data: { id: string } }).data;
  await Promise.all(notes.map(async (note) => {
    const moved = await apiJson(`/api/notes/${note.id}/notebook`, session.access_token, { method: 'PATCH', body: JSON.stringify({ notebookId: notebook.id, expectedVersion: note.version, deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }) });
    expect(moved.response.ok).toBe(true);
  }));

  await page.reload();
  await page.getByRole('combobox', { name: 'Filter notes by notebook' }).selectOption(notebook.id);
  await expect(page.locator('.q-home-notes .q-note-card')).toHaveCount(9);
  await expect(page.locator('.q-home-notes')).toContainText('Notebook filter 9');

  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await page.getByRole('combobox', { name: 'Filter notes by notebook' }).selectOption(notebook.id);
    await expect(page.locator('.q-home-notes .q-note-card')).toHaveCount(9);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
