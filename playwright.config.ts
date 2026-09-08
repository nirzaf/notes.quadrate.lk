import { defineConfig, devices } from '@playwright/test';

const servedFunctions = ['qnotes-api', ...(process.env.QNOTES_E2E_SERVE_WORKERS === '0' ? [] : ['embedding-worker', 'attachment-worker'])].join(' ');
const webServers = [
  {
    command: 'pnpm --filter @qnotes/web dev --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  ...(process.env.QNOTES_E2E_EXTERNAL_API === '1'
    ? []
    : [{
        command: `pnpm exec supabase functions serve ${servedFunctions} --env-file supabase/functions/.env.test --no-verify-jwt`,
        url: 'http://127.0.0.1:54321/functions/v1/qnotes-api/api/health',
        reuseExistingServer: true,
        timeout: 120_000,
      }]),
];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: webServers,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
