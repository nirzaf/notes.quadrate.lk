import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testMatch: /release-smoke\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalTimeout: 5 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    ...baseConfig.use,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
