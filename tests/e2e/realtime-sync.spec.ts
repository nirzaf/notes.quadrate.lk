import { test, expect } from './test-fixtures';
import { createDevice, getNoteApi, poll, signInSession, updateNoteApi } from './helpers';

function noteIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/notes\/([^/]+)$/);
  if (!match?.[1]) throw new Error(`Missing note ID in ${url}`);
  return match[1];
}

test('synchronizes committed autosaves, recovers after reconnect, and ignores self events', async ({ browser }) => {
  const deviceA = await createDevice(browser);
  const deviceB = await createDevice(browser);
  try {
    await deviceA.page.getByRole('button', { name: 'New note' }).first().click();
    await expect.poll(() => new URL(deviceA.page.url()).pathname, { timeout: 15_000 }).toMatch(/\/notes\/[0-9a-f-]+$/);
    const noteId = noteIdFromUrl(deviceA.page.url());

    await expect.poll(() => deviceB.page.getByText('Untitled note', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await deviceB.page.goto(`/notes/${noteId}`);
    await expect(deviceB.page.locator('.cm-content')).toBeVisible();

    let detailRequestsA = 0;
    deviceA.page.on('request', (request) => {
      if (request.url().includes(`/api/notes/${noteId}`) && request.method() === 'GET') detailRequestsA += 1;
    });
    const editorA = deviceA.page.locator('.cm-content');
    await editorA.fill('# Remote update\n\nCommitted from device A.');
    const session = await signInSession();
    const updated = await poll(() => getNoteApi(session.access_token, noteId), (note) => note.contentMarkdown.includes('Committed from device A.'), 15_000);
    expect(updated.version).toBeGreaterThan(1);
    await expect(deviceB.page.locator('.cm-content')).toContainText('Committed from device A.', { timeout: 15_000 });
    expect(detailRequestsA).toBeLessThan(6);
    const settledRequests = detailRequestsA;
    await expect.poll(() => detailRequestsA, { timeout: 2_000, intervals: [100, 200, 400, 800] }).toBeLessThanOrEqual(settledRequests + 1);

    await deviceB.context.setOffline(true);
    const offlineBase = await getNoteApi(session.access_token, noteId);
    const offlineSaved = await updateNoteApi(session.access_token, offlineBase, '# Cursor recovery\n\nSaved while device B was disconnected.');
    expect(offlineSaved.version).toBe(offlineBase.version + 1);
    await deviceB.context.setOffline(false);
    await deviceB.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(deviceB.page.locator('.cm-content')).toContainText('Saved while device B was disconnected.', { timeout: 20_000 });

    await deviceA.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(deviceA.page.getByText('Note moved to the trash.')).toBeVisible();
    await expect(deviceB.page.getByText('This note could not be opened.')).toBeVisible({ timeout: 15_000 });
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});
