# GitHub Actions CI/CD

The workflow in [`workflows/ci.yml`](workflows/ci.yml) uses GitHub-hosted
`ubuntu-latest` runners. Pull requests run the core checks, local Supabase
integration tests with the complete Playwright E2E suite, and the search
regression job. Search evaluation remains path-gated after the job starts. A
push to `master` runs the release gate and then deploys the production
Supabase functions, migrations, frontend, and Cloudflare Pages site.

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
pnpm run verify:local
```

The GitHub-hosted runner provides Docker for the local Supabase integration and
search regression jobs; no host-local `.env.local` file is required by CI/CD.
