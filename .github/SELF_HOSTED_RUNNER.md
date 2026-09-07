# Self-hosted GitHub Actions runner

Quadrate Notes runs its CI and production CD jobs on a repository-scoped Linux
x64 runner with the `qnotes-ci` label. The workflow is
[`.github/workflows/ci.yml`](workflows/ci.yml); pull requests run the core,
integration, and search checks, while pushes to `master` deploy after all three
checks pass.

## Runner requirements

Use a dedicated Ubuntu 22.04/24.04 VM or server. Do not install the runner on
the production Supabase or Cloudflare host. The runner needs:

- Git, curl, Corepack, and outbound HTTPS access.
- Docker, for the local Supabase integration and search jobs.
- Enough disk space for Supabase containers and Playwright Chromium.
- A runner account able to install Chromium system dependencies, or Chromium
  dependencies preinstalled by the machine image.

The workflow installs the pinned Node.js, Deno, pnpm, and project dependencies.
It installs the Supabase CLI from the repository and uses the pinned Wrangler
version from the deployment procedure.

## Register the runner

In the private repository, open **Settings → Actions → Runners → New
self-hosted runner**, select Linux/x64, and register it with the label
`qnotes-ci`. Keep the default labels `self-hosted`, `linux`, and `x64`.

Prefer a service-managed or ephemeral runner. Restrict the runner group to
`nirzaf/notes.quadrate.lk`, run it as a dedicated unprivileged account, and
rebuild or clean the machine after unexpected workflow failures. Self-hosted
runners are persistent machines and should not be shared with unrelated
repositories.

## Production secrets

Create a GitHub **production environment** and add these secrets there:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (Cloudflare Pages Edit scope)

Require an environment reviewer before deployment. The workflow never stores
production secrets in the repository and does not use production credentials in
the test jobs. The deployment applies migrations, deploys Edge Functions,
builds Pages, and then verifies the public health endpoints.

## Host-local deployment environment

For the current runner host, the deployment job also reads the ignored file
`/root/Desktop/notes.quadrate.lk/.env.local`. Set the runner service
environment variable `QNOTES_CI_ENV_FILE` to a different absolute path when the
runner is installed elsewhere. Only the deployment variables are exported to
later steps, and each value is masked before export; the file is never copied to
the repository checkout or uploaded as an artifact.

The checked-in host file is currently owned by `root` with mode `600`. Do not
run the runner as `root` just to read it. Instead, give the dedicated runner
account controlled read access, or create a runner-owned `600` copy outside the
checkout and set `QNOTES_CI_ENV_FILE` to that path. Keep the file out of the Git
working tree and backups shared with other jobs.

The current local file does not contain `SUPABASE_DB_PASSWORD` or
`CLOUDFLARE_API_TOKEN`, so production deployment will stop until those are
provided. Wrangler can use the existing `CLOUDFLARE_API_KEY` plus
`CLOUDFLARE_EMAIL` pair as a compatibility fallback, but replace that broad
global API key with a scoped Cloudflare API token when possible.
