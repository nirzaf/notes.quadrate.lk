import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, signInPage, signInSession } from './helpers';

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
