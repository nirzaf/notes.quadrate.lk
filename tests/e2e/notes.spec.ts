import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, expectEditorMode, expectPreviewMode, getNoteApi, listNotesApi, OWNER, poll, signInPage, signInSession } from './helpers';

const markdownWithBlocks = `# Browser note

Keep the canonical Markdown.

\`\`\`bash
echo normal-fence
\`\`\`

:::copy{id="production-deploy" title="Production Deploy" lang="bash" type="command"}
pnpm run deploy -- --environment staging
:::
`;

function noteIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/notes\/([^/]+)$/);
  if (!match?.[1]) throw new Error(`Missing note ID in ${url}`);
  return match[1];
}

test('creates, edits, renders, copies, deletes, restores, and isolates notes', async ({ page, browser }) => {
  await signInPage(page);
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  const noteId = noteIdFromUrl(page.url());
  await expectEditorMode(page);
  const editor = page.locator('.cm-content');
  await editor.fill(markdownWithBlocks);

  const session = await signInSession();
  const saved = await poll(() => getNoteApi(session.access_token, noteId), (note) => note.contentMarkdown === markdownWithBlocks, 15_000);
  expect(saved.version).toBeGreaterThan(1);

  await page.reload();
  await expectPreviewMode(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectEditorMode(page);
  await expect(editor).toContainText('normal-fence');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expectPreviewMode(page);
  const preview = page.getByLabel('Rendered note preview');
  await expect(preview.locator('button[data-qnotes-block-key]')).toHaveCount(2);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
  await preview.locator('button[data-qnotes-block-key]').first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('echo normal-fence');
  await preview.locator('button[data-qnotes-block-key="production-deploy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('pnpm run deploy -- --environment staging');

  await page.getByRole('button', { name: 'Copy Markdown' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(markdownWithBlocks);

  const current = await getNoteApi(session.access_token, noteId);
  const duplicate = '# Invalid\n\n:::copy{id="duplicate"}\none\n:::\n\n:::copy{id="duplicate"}\ntwo\n:::\n';
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectEditorMode(page);
  await page.locator('.cm-content').fill(duplicate);
  await expect(page.getByRole('status')).toContainText('Save failed', { timeout: 10_000 });
  await expect.poll(async () => (await getNoteApi(session.access_token, noteId)).version).toBe(current.version);

  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await expect(page.getByRole('heading', { name: 'Save is blocked' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete anyway' }).click();
  await expect(page.getByText('Note moved to the trash.')).toBeVisible();
  await expect.poll(async () => (await listNotesApi(session.access_token, true)).find((item) => item.id === noteId)?.deletedAt ?? null).not.toBeNull();

  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('menuitem', { name: 'Restore note' }).click();
  await expect(page.getByText('Note restored.')).toBeVisible();
  await expect.poll(async () => (await listNotesApi(session.access_token, true)).find((item) => item.id === noteId)?.deletedAt ?? null).toBeNull();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signInPage(otherPage, { email: 'other@qnotes.local', password: 'Qnotes-Test-Other-2026!' });
  await otherPage.goto(`/notes/${noteId}`);
  await expect(otherPage.getByText('This note could not be opened.')).toBeVisible();
  await other.close();
});

test('flushes a just-typed edit before leaving the note', async ({ page }) => {
  await signInPage(page);
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  const noteId = noteIdFromUrl(page.url());
  await expectEditorMode(page);
  await page.locator('.cm-content').fill('Typed immediately before navigation.\n');
  await page.getByRole('link', { name: 'Quadrate Notes home' }).click();
  await expect(page).toHaveURL(/\/$/);

  const session = await signInSession();
  const saved = await poll(() => getNoteApi(session.access_token, noteId), (note) => note.contentMarkdown === 'Typed immediately before navigation.\n', 10_000);
  expect(saved.contentMarkdown).toBe('Typed immediately before navigation.\n');
});

test('keeps newer typing when an earlier autosave response is delayed', async ({ page }) => {
  await signInPage(page);
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  const noteId = noteIdFromUrl(page.url());
  await expectEditorMode(page);
  const firstPatchStarted = page.waitForRequest((request) => request.url().includes(`/api/notes/${noteId}`) && request.method() === 'PATCH');
  let releaseFirstPatch!: () => void;
  const firstPatchReleased = new Promise<void>((resolve) => { releaseFirstPatch = resolve; });
  let patchCount = 0;
  await page.route('**/functions/v1/qnotes-api/api/notes/**', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    patchCount += 1;
    if (patchCount !== 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await firstPatchReleased;
    await route.fulfill({ response });
  });

  const editor = page.locator('.cm-content');
  await editor.fill('First revision.\n');
  await firstPatchStarted;
  await editor.fill('First revision.\n\nSecond revision typed while saving.\n');
  releaseFirstPatch();
  await page.getByRole('link', { name: 'Quadrate Notes home' }).click();
  await expect(page).toHaveURL(/\/$/);
  const session = await signInSession();
  await expect.poll(async () => (await getNoteApi(session.access_token, noteId)).contentMarkdown, { timeout: 10_000 }).toBe('First revision.\n\nSecond revision typed while saving.\n');
  await page.unroute('**/functions/v1/qnotes-api/api/notes/**');
});

test('rejects duplicate named block IDs through the API contract', async () => {
  const session = await signInSession(OWNER);
  const note = await createNoteApi(session.access_token, `Duplicate blocks ${crypto.randomUUID()}`, 'one');
  const duplicate = ':::copy{id="same"}\none\n:::\n\n:::copy{id="same"}\ntwo\n:::\n';
  const { response, body } = await apiJson(`/api/notes/${note.id}`, session.access_token, {
    method: 'PATCH',
    body: JSON.stringify({ title: note.title, slug: note.slug, contentMarkdown: duplicate, tags: note.tags, expectedVersion: note.version, deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }),
  });
  expect(response.status).toBe(422);
  expect(JSON.stringify(body)).toContain('DUPLICATE_BLOCK_KEY');
});

test('saves editable metadata and copies the exact current draft before autosave', async ({ page }) => {
  await signInPage(page);
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  const noteId = noteIdFromUrl(page.url());
  await expectEditorMode(page);
  await page.getByLabel('Title').fill('Renamed workflow note');
  await page.getByLabel('Add a tag').fill('Operations');
  await page.getByLabel('Add a tag').press('Enter');
  const exactDraft = '# Immediate copy\n\nThe body is newer than the server response.\n';
  await page.locator('.cm-content').fill(exactDraft);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
  await page.getByRole('button', { name: 'Copy Markdown' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exactDraft);
  const session = await signInSession();
  await expect.poll(() => getNoteApi(session.access_token, noteId), { timeout: 15_000 }).toMatchObject({ title: 'Renamed workflow note', tags: ['operations'], contentMarkdown: exactDraft });
  await page.reload();
  await expect(page.getByLabel('Title')).toHaveValue('Renamed workflow note');
  await expect(page.getByText('operations', { exact: true })).toBeVisible();
});

test('opens a deleted note from Trash and restores it without a duplicate active entry', async ({ page }) => {
  await signInPage(page);
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  const noteId = noteIdFromUrl(page.url());
  await expectEditorMode(page);
  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await expect(page.getByText('Note moved to the trash.')).toBeVisible();
  await page.getByRole('link', { name: 'Trash' }).first().click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.locator('.q-trash-item')).toContainText('Untitled note');
  await page.locator('.q-trash-item').filter({ hasText: 'Untitled note' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Note restored.')).toBeVisible();
  await expect.poll(async () => (await listNotesApi((await signInSession()).access_token, false)).filter((item) => item.id === noteId)).toHaveLength(1);
  await expect(page.locator('.q-trash-item').filter({ hasText: 'Untitled note' })).toHaveCount(0);
});
