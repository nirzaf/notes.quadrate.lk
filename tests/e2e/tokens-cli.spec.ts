import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from './test-fixtures';
import { apiJson, createNoteApi, localEnv, signInPage, signInSession } from './helpers';

const execFileAsync = promisify(execFile);

async function runCli(token: string, ...args: string[]): Promise<string> {
  const env = await localEnv();
  const result = await execFileAsync('node', ['packages/cli/dist/index.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, QNOTES_URL: env.apiUrl, QNOTES_TOKEN: token },
    maxBuffer: 2_000_000,
  });
  return result.stdout;
}

test('manages scoped tokens and exercises the built CLI', async ({ page }) => {
  const session = await signInSession();
  const blockContent = 'printf cli-block-output';
  const note = await createNoteApi(session.access_token, `CLI fixture ${crypto.randomUUID()}`, `:::copy{id="cli-block" title="CLI Block" lang="bash" type="command"}\n${blockContent}\n:::\n`);

  await signInPage(page);
  await page.goto('/settings/tokens');
  const readName = `read-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Token name').fill(readName);
  await page.getByRole('button', { name: 'Create token' }).click();
  const readToken = (await page.locator('code').textContent())?.trim();
  if (!readToken) throw new Error('The browser did not display the read token.');

  const searchOutput = await runCli(readToken, 'search', 'cli-block', '--json');
  const searchRows: unknown = JSON.parse(searchOutput);
  expect(Array.isArray(searchRows)).toBe(true);
  expect(JSON.stringify(searchRows)).toContain(note.id);
  expect(await runCli(readToken, 'block', 'get', note.slug, 'cli-block')).toBe(`${blockContent}\n`);

  const denied = await apiJson('/api/notes', readToken, { method: 'POST', body: JSON.stringify({ title: 'Denied', contentMarkdown: '', tags: [], deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }) });
  expect(denied.response.status).toBe(403);
  expect(JSON.stringify(denied.body)).toContain('INSUFFICIENT_SCOPE');

  const writeName = `write-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Token name').fill(writeName);
  const writeScope = page.locator('label').filter({ hasText: 'notes:write' }).locator('input[type="checkbox"]');
  await writeScope.check();
  const writeTokenResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/functions/v1/qnotes-api/api/tokens'));
  await page.getByRole('button', { name: 'Create token' }).click();
  await writeTokenResponse;
  await expect.poll(async () => (await page.locator('code').textContent())?.trim() ?? '').not.toBe(readToken);
  const writeToken = (await page.locator('code').textContent())?.trim();
  if (!writeToken) throw new Error('The browser did not display the write token.');

  const captureText = `Captured by CLI ${crypto.randomUUID()}`;
  const captureOutput = await runCli(writeToken, 'capture', captureText);
  const captured = JSON.parse(captureOutput) as Record<string, unknown>;
  expect(captured.contentMarkdown).toBe(`${captureText}\n`);

  const tokenRow = page.locator('.q-token-row').filter({ hasText: writeName });
  await expect(tokenRow).toBeVisible();
  await tokenRow.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Token revoked.')).toBeVisible();
  const revoked = await apiJson('/api/notes', writeToken, { method: 'POST', body: JSON.stringify({ title: 'Revoked', contentMarkdown: '', tags: [], deviceId: crypto.randomUUID(), mutationId: crypto.randomUUID() }) });
  expect(revoked.response.status).toBe(401);
});
