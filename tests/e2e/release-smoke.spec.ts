import { AxeBuilder } from '@axe-core/playwright';
import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';
import { createNoteApi, expectEditorMode, expectPreviewMode, getNoteApi, signInPage, signInSession } from './helpers';

test.describe.configure({ timeout: 45_000 });

function capturePageErrors(page: Page): () => void {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return () => expect(errors, errors.map((error) => error.message).join('\n')).toEqual([]);
}

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`).join('\n');
  expect(results.violations, `${label} accessibility violations\n${summary}`).toEqual([]);
}

test('covers note edit-preview and browser navigation', async ({ page }) => {
  const assertNoPageErrors = capturePageErrors(page);
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Release smoke ${crypto.randomUUID().slice(0, 8)}`, '# Release smoke note\n\nBrowser preview contract marker.');
  const title = `${note.title} edited`;
  const markdown = '# Release smoke note\n\nBrowser preview contract marker.';

  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectEditorMode(page);
  await page.getByLabel('Title').fill(title);
  await page.locator('.cm-content').fill(markdown);
  await expect.poll(() => getNoteApi(session.access_token, note.id), { timeout: 20_000 }).toMatchObject({ title, contentMarkdown: markdown });

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expectPreviewMode(page);
  await expect(page.getByLabel('Rendered note preview')).toContainText('Browser preview contract marker.');
  await page.getByRole('link', { name: 'Quadrate Notes home' }).click();
  await expect(page).toHaveURL(/\/$/);
  const noteCard = page.locator('.q-note-card').filter({ hasText: title });
  await expect(noteCard).toBeVisible();
  await noteCard.click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expectPreviewMode(page);
  await expect(page.getByLabel('Rendered note preview')).toContainText('Browser preview contract marker.');
  assertNoPageErrors();
});

test('covers the Vault administration routes and surfaces', async ({ page }) => {
  await signInPage(page);
  await page.getByRole('link', { name: 'Agent Vault' }).first().click();
  await expect(page).toHaveURL(/\/vault$/);
  await expect(page.locator('.q-working-header').getByRole('heading', { name: 'Agent Vault', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Vault administration' })).toContainText('Projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New project', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Agent tokens', exact: true }).click();
  await expect(page).toHaveURL(/\/vault\/agents$/);
  await expect(page.getByRole('heading', { name: 'Agent credentials', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create qvt token', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await expect(page).toHaveURL(/\/vault\/audit$/);
  await expect(page.getByRole('heading', { name: 'Vault audit history', exact: true })).toBeVisible();
});

test('renders a synthetic public share through its browser fragment', async ({ page }) => {
  const token = `qns_${'s'.repeat(43)}`;
  const title = 'Synthetic public smoke note';
  await page.route('**/public/share/resolve', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ token });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          title,
          contentMarkdown: '# Public smoke note\n\nThis is a local-only shared rendering marker.',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
  });

  await page.goto(`/share#${token}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.q-public-share-note .q-preview')).toContainText('local-only shared rendering marker.');
  await expect(page.locator('.q-attachment-panel')).toHaveCount(0);
  await expect(page).toHaveTitle(new RegExp(`${title} · Quadrate Notes`));
});

test('keeps the stable login surface free of automated accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Your notes, in flow.', exact: true })).toBeVisible();
  await expectAccessible(page, 'login');
});

test('covers the Preview-first note and attachment panel UI', async ({ page }) => {
  const session = await signInSession();
  const note = await createNoteApi(session.access_token, `Attachment smoke ${crypto.randomUUID().slice(0, 8)}`, '# Attachment smoke note\n\nAttachment panel fixture.');

  await signInPage(page);
  await page.goto(`/notes/${note.id}`);
  await expectPreviewMode(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectEditorMode(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expectPreviewMode(page);
  const panel = page.getByRole('region', { name: 'Attachments' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('No attachments yet.');
  await panel.locator('summary').click();
  await expect(panel.getByLabel('Add a file')).toBeVisible();
  await expect(panel).toContainText('TXT, Markdown, PDF, PNG, JPEG, or WebP');
  await panel.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Visible Area/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Entire Page/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Cropped Zone/ })).toBeVisible();
  await page.keyboard.press('Escape');
});
