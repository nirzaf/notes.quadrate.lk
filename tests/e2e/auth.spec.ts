import { test, expect } from './test-fixtures';
import { OWNER, signInPage } from './helpers';

test('authenticates, restores a session, signs out, and protects routes', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|credentials|password/i);

  await signInPage(page);
  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/settings/tokens');
  await expect(page).toHaveURL(/\/login$/);
});
