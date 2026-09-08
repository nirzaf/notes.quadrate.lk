# GitHub Actions CI/CD

The workflow in [`workflows/ci.yml`](workflows/ci.yml) uses GitHub-hosted
`ubuntu-latest` runners. Pull requests run the core checks, local Supabase
SQL/database integration tests, the search regression job, and the short
Chromium browser smoke job. The smoke job installs bundled Chromium, starts
local Supabase, writes local environment files, seeds only the dedicated test
users, and starts Vite and only `qnotes-api` in bounded workflow-managed
processes. The workflow records each PID and log under `.tmp`, probes the local
Vite root and API health endpoint before running the smoke command with
`QNOTES_E2E_EXTERNAL_API=1`, and stops both processes before stopping Supabase.
Playwright reuses the workflow-managed Vite process and uses the focused release
smoke config with one worker and explicit deadlines. Search evaluation remains
path-gated after the job starts. The complete Playwright E2E
suite remains a local/manual command (`pnpm run test:e2e`) and is not run by
CI/CD. The login smoke checks only an explicit structural axe rule allowlist;
full axe coverage remains in the complete local/manual suite and Issue #22. A
push to `master` runs the release gate only when the browser smoke and all other
enabled checks pass, then deploys the production Supabase functions, migrations,
frontend, and Cloudflare Pages site.

## Production environment

Deployment credentials belong in the GitHub `production` environment, never in
the repository or a workflow file. Configure these environment secrets:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The workflow also accepts the compatibility fallback `CLOUDFLARE_API_KEY` and
`CLOUDFLARE_EMAIL`, but a scoped Cloudflare API token is preferred. GitHub
automatically masks configured secret values in Actions logs.

The `deploy` job is restricted to pushes to `master`, uses the `production`
environment, and is not part of pull-request execution. Keep production
environment reviewers enabled before using this prototype for unattended
production releases.

## Local reproduction

Use the pinned toolchain and run the same critical checks locally when needed:

```bash
corepack enable
corepack install --global pnpm@12.1.0
pnpm install --frozen-lockfile
```

The GitHub-hosted runner provides Docker for the local Supabase integration and
search regression and browser smoke jobs; no host-local `.env.local` file is
required by CI/CD. Before running the complete local gate or the browser smoke,
ensure Docker is running and complete the local Supabase/test-user/browser
setup:

```bash
pnpm exec supabase start
pnpm run local:env
pnpm run seed:test-users
pnpm exec playwright install chromium
```

For the complete local gate, run:

```bash
pnpm run verify:local
```

To reproduce the browser smoke directly after the setup above, run:

```bash
pnpm run test:e2e:smoke
```
