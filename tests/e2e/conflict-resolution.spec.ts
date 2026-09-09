import { test, expect } from './test-fixtures';
import { apiJson, createDevice, createNoteApi, expectEditorMode, expectPreviewMode, getNoteApi, poll, signInSession, updateNoteApi } from './helpers';

const apiPath = '**/functions/v1/qnotes-api/api/notes/**';

function noteUrl(noteId: string): string {
  return `/notes/${noteId}`;
}

async function blockPatchRequests(page: import('@playwright/test').Page): Promise<void> {
  await page.route(apiPath, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { contentMarkdown?: unknown };
    if (typeof body.contentMarkdown === 'string' && body.contentMarkdown.includes('manual merged result')) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Test-held concurrent draft.', requestId: crypto.randomUUID() } }) });
  });
}

test('surfaces overlapping edits and supports every conflict resolution action', async ({ browser }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Conflict ${crypto.randomUUID()}`, 'base line\n');
  const deviceA = await createDevice(browser);
  const deviceB = await createDevice(browser);
  try {
    await deviceA.page.goto(noteUrl(note.id));
    await deviceB.page.goto(noteUrl(note.id));
    await expectPreviewMode(deviceA.page);
    await expectPreviewMode(deviceB.page);
    await deviceA.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expectEditorMode(deviceA.page);
    await deviceB.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expectEditorMode(deviceB.page);

    await blockPatchRequests(deviceA.page);
    await blockPatchRequests(deviceB.page);
    await deviceA.page.locator('.cm-content').fill('base line\nremote overlapping edit\n');
    await deviceB.page.locator('.cm-content').fill('base line\nlocal overlapping edit\n');
    await expect(deviceB.page.getByRole('status')).toContainText('Saving');

    const serverBase = await getNoteApi(session.access_token, note.id);
    await updateNoteApi(session.access_token, serverBase, 'base line\nremote overlapping edit\n');
    await expect(deviceB.page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await deviceA.page.unroute(apiPath);
    await deviceB.page.unroute(apiPath);

    await deviceB.page.getByRole('button', { name: 'Use mine' }).click();
    await expect.poll(async () => (await getNoteApi(session.access_token, note.id)).contentMarkdown).toBe('base line\nlocal overlapping edit\n');
    await expect(deviceB.page.getByRole('status')).toHaveText('Saved');

    let current = await getNoteApi(session.access_token, note.id);
    await blockPatchRequests(deviceB.page);
    await deviceB.page.locator('.cm-content').fill('base line\nlocal second edit\n');
    await expect(deviceB.page.locator('.cm-content')).toContainText('local second edit');
    await updateNoteApi(session.access_token, current, 'base line\nremote second edit\n');
    await expect(deviceB.page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await deviceB.page.unroute(apiPath);
    await deviceB.page.getByRole('button', { name: 'Use remote' }).click();
    await expect.poll(async () => (await getNoteApi(session.access_token, note.id)).contentMarkdown).toBe('base line\nremote second edit\n');

    current = await getNoteApi(session.access_token, note.id);
    await blockPatchRequests(deviceB.page);
    await deviceB.page.locator('.cm-content').fill('base line\nlocal third edit\n');
    await expect(deviceB.page.locator('.cm-content')).toContainText('local third edit');
    await updateNoteApi(session.access_token, current, 'base line\nremote third edit\n');
    await expect(deviceB.page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await deviceB.page.unroute(apiPath);
    await deviceB.page.getByLabel('Edit merged result').fill('base line\nmanual merged result\n');
    await deviceB.page.getByRole('button', { name: 'Save merged result' }).click();
    await expect.poll(async () => (await getNoteApi(session.access_token, note.id)).contentMarkdown).toBe('base line\nmanual merged result\n');
    await expect(deviceB.page.getByRole('status')).toHaveText('Saved');

    current = await getNoteApi(session.access_token, note.id);
    await blockPatchRequests(deviceB.page);
    await deviceB.page.locator('.cm-content').fill('base line\nlocal draft retained\n');
    await expect(deviceB.page.locator('.cm-content')).toContainText('local draft retained');
    await updateNoteApi(session.access_token, current, 'base line\nremote final edit\n');
    await expect(deviceB.page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await deviceB.page.unroute(apiPath);
    await deviceB.page.getByRole('button', { name: 'Cancel and keep local draft' }).click();
    await expect(deviceB.page.getByRole('dialog')).toBeHidden();
    await expect(deviceB.page.locator('.cm-content')).toContainText('local draft retained');

    await deviceB.page.reload();
    await expectPreviewMode(deviceB.page);
    await deviceB.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expectEditorMode(deviceB.page);
    await expect(deviceB.page.locator('.cm-content')).toContainText('local draft retained', { timeout: 15_000 });
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});

test('preserves a dirty draft and can recover it after remote deletion', async ({ browser }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Deleted elsewhere ${crypto.randomUUID()}`, 'server baseline\n');
  const device = await createDevice(browser);
  try {
    await device.page.goto(noteUrl(note.id));
    await expectPreviewMode(device.page);
    await device.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expectEditorMode(device.page);
    await blockPatchRequests(device.page);
    await device.page.locator('.cm-content').fill('local draft before remote deletion\n');
    await expect(device.page.locator('.cm-content')).toContainText('local draft before remote deletion');

    const deleted = await apiJson(`/api/notes/${note.id}`, session.access_token, {
      method: 'DELETE',
      body: JSON.stringify({ expectedVersion: note.version, deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }),
    });
    expect(deleted.response.status).toBe(200);
    await expect(device.page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await expect(device.page.getByRole('heading', { name: 'Note deleted elsewhere' })).toBeVisible();
    await expect(device.page.getByRole('button', { name: 'Save as new note' })).toBeVisible();

    await device.page.unroute(apiPath);
    await device.page.getByRole('button', { name: 'Save as new note' }).click();
    await expect.poll(() => new URL(device.page.url()).pathname, { timeout: 15_000 }).not.toBe(noteUrl(note.id));
    await expect(device.page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
    const recoveredId = new URL(device.page.url()).pathname.split('/').at(-1)!;
    expect(recoveredId).not.toBe(note.id);
    const recovered = await poll(async () => {
      const result = await apiJson(`/api/notes/${recoveredId}`, session.access_token);
      if (!result.response.ok || !result.body || typeof result.body !== 'object' || !('data' in result.body)) {
        return null;
      }
      return result.body.data as { title: string; contentMarkdown: string };
    }, (value) => Boolean(value && value.title.endsWith(' (recovered)') && value.contentMarkdown === 'local draft before remote deletion\n'), 10_000);
    if (!recovered) throw new Error('Recovered note was not visible through the API before the polling deadline.');
    expect(recovered.title).toContain(' (recovered)');
    expect(recovered.contentMarkdown).toBe('local draft before remote deletion\n');
  } finally {
    await device.context.close();
  }
});

test('reconciles a persisted older draft with a newer remote version after reload', async ({ browser }) => {
  const session = await signInSession();
  const notebookResponse = await apiJson('/api/notebooks', session.access_token, { method: 'POST', body: JSON.stringify({ name: `Recovered ${crypto.randomUUID()}` }) });
  const notebookId = notebookResponse.response.ok && notebookResponse.body && typeof notebookResponse.body === 'object' && 'data' in notebookResponse.body
    && notebookResponse.body.data && typeof notebookResponse.body.data === 'object' && 'id' in notebookResponse.body.data && typeof notebookResponse.body.data.id === 'string'
    ? notebookResponse.body.data.id
    : null;
  if (!notebookId) throw new Error(`Unable to create the recovery notebook: ${JSON.stringify(notebookResponse.body)}`);
  const note = await createNoteApi(session.access_token, `Reload recovery ${crypto.randomUUID()}`, 'alpha\nbeta\ngamma\n');
  const device = await createDevice(browser);
  try {
    await device.page.goto(noteUrl(note.id));
    await expectPreviewMode(device.page);
    const databaseName = `qnotes-account-${encodeURIComponent(session.user.id)}`;
    await device.page.evaluate(async ({ databaseName, draft }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open the test draft database.'));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('drafts', 'readwrite');
        transaction.objectStore('drafts').put(draft);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to seed the test draft.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Unable to seed the test draft.'));
      });
      database.close();
    }, {
      databaseName,
      draft: {
        noteId: note.id,
        baseVersion: note.version,
        baseMarkdown: note.contentMarkdown,
        localMarkdown: 'local alpha\nbeta\ngamma\n',
        mutationId: crypto.randomUUID(),
        baseTitle: note.title,
        localTitle: note.title,
        baseTags: [],
        localTags: [],
        baseNotebookId: null,
        localNotebookId: notebookId,
        updatedAt: new Date().toISOString(),
      },
    });
    await updateNoteApi(session.access_token, note, 'alpha\nbeta\nremote gamma\n');
    await device.page.reload();
    await expect.poll(async () => await getNoteApi(session.access_token, note.id), { timeout: 15_000 }).toMatchObject({ contentMarkdown: 'local alpha\nbeta\nremote gamma\n', notebookId });
    await device.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expectEditorMode(device.page);
    await expect(device.page.locator('.cm-content')).toContainText('local alpha');
    await expect(device.page.locator('.cm-content')).toContainText('remote gamma');
    await expect.poll(() => device.page.evaluate(async ({ databaseName, noteId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to reopen the test draft database.'));
      });
      const draft = await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction('drafts', 'readonly');
        const request = transaction.objectStore('drafts').get(noteId);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error('Unable to read the test draft.'));
      });
      database.close();
      return draft;
    }, { databaseName, noteId: note.id })).toBeNull();
  } finally {
    await device.context.close();
  }
});
