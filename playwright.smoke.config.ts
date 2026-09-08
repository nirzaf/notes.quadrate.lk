import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testMatch: /release-smoke\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  globalTimeout: 2 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    ...baseConfig.use,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
