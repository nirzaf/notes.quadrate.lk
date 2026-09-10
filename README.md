# QNotes

`notes.quadrate.lk` is a browser-first Markdown notes workspace for keeping canonical private notes, organizing them into notebooks, reusing copyable knowledge blocks, searching across notes and extracted attachments, and optionally sharing one saved note through an explicit read-only link. The workspace is accessible through HTTP, JavaScript, or the `qnotes` CLI.

The repository is a pnpm monorepo. The web app is a Vite/React PWA, the API is a Supabase Edge Function, and the database stores Markdown as the source of truth.

## Current capabilities

- Email/password sign-in and self-service account creation through Supabase Auth.
- A Markdown editor with Edit and Preview views, 800 ms quiet-period autosave, copy-as-Markdown/plain text/rendered content, and one-click copyable blocks.
- Personal notebooks. The sidebar and home page can show All notes, Unfiled notes, or one named notebook. Notes can be moved from the note editor.
- Progressive local-first search in the web app, with recent local title/tag matches followed by server-side title/body relevance, structured notebook/tag/source/date filters, and results from copyable blocks and extracted attachment text. The API additionally supports semantic and hybrid search with opaque request-bound cursors.
- Private attachments stored in Supabase Storage. Plain text, Markdown, and text-bearing PDFs are indexed asynchronously; PNG, JPEG, and WebP files are stored but report that image OCR is unsupported. From a note's Attachments panel, supported attachments can be previewed privately in-app: images render as images, PDFs use the browser's embedded viewer, and text/Markdown render as escaped plain text. Screenshots can be captured as the Visible Area, the Entire Page, or a Cropped Zone and are sent through the same private attachment flow.
- Versioned mutations, private Realtime Broadcast invalidation, reconnect recovery, IndexedDB draft persistence, and a conflict resolver for concurrent edits.
- Personal API tokens with least-privilege scopes for scripts, agents, backups, and the CLI.
- Agent-facing exact reads use UTF-8-safe bounded pages. Notes, reusable blocks, context documents, and public shares expose byte or line ranges, serialized response ceilings, continuation metadata, and version/hash/policy-bound cursors; native MCP pages default to 24 KiB within a 64 KiB wire envelope. See [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md) for the paging contract.
- Revocable, read-only public note links using `qns_...` secrets held only in URL fragments; public views expose only the saved title and Markdown body, never attachments or workspace metadata.
- A guided Integrations page for read-only-by-default Hermes setup, a least-privilege public-sharing profile, explicit write scopes, real token expiry choices, one-time secret/config display, and separate API versus Hermes verification.
- Note Markdown exports and version-two workspace ZIP exports containing active notes, attachments (including stored images whose extraction status is `unsupported`), notebooks, and a manifest. Exports preflight metadata and archive-entry limits before downloading attachment bytes.

The repository ships a native stdio MCP server in `packages/mcp-server` and a hosted, read-only-by-default Streamable HTTP MCP endpoint for Gemini Spark at `https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-mcp`, including standard OAuth discovery, dynamic client registration, PKCE consent, and public-share resolution through `resolve_public_share`. Agent-facing MCP content reads are bounded, preserve exact UTF-8 source bytes, and return continuation metadata for large notes and blocks. The native `write` profile omits public-share creation by default; set `QNOTES_MCP_ENABLE_PUBLIC_SHARE=true` only when its `QNOTES_WRITE_TOKEN` also has `shares:write`, or use the separate least-privilege `share` profile. An explicitly configured `QNOTES_MCP_PROFILE=share` hosted deployment can additionally expose guarded, 24-hour public-share creation when the authenticated caller’s personal token has `shares:write`; no shared owner credential is configured. Unknown or absent profile values remain read-only. See [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md) for the REST API, CLI, JavaScript client, and MCP setup.

## QNotes for Hermes companion plugin

QNotes also ships an external native Hermes companion under
`integrations/hermes-plugin/`. It registers only `/qnotes`, `/qnotes-help`,
`/qnotes-status`, and the explicit `qnotes:workflow` skill; the existing stdio
MCP server remains the sole implementation of Notes and Vault business tools.
Build the trusted workspace first, then use
`scripts/export-hermes-plugin-config.mjs` to create a reviewable fragment.
The exporter delegates tool/profile truth to `buildHermesMcpConfig()`, emits
placeholders only, and does not write Hermes configuration or contact the API.
Use a disposable `HERMES_HOME` for Plugin Doctor and the real loader/MCP
handshake. The tested Hermes v0.21 CLI has no `hermes plugins compat`
subcommand; re-check `hermes plugins --help` before using a compatibility
command from a newer release. Use a pinned reviewed source commit for
installation. Publication and production deployment are separate operations
and are not performed by the plugin.

## Using the web app

Open `/login` to sign in or create an account. Authenticated users land on the private notes workspace at `/`.

The home page provides a paginated recent-notes view, a search field, and a notebook filter. Search shows matching recent local snapshots immediately while the API request waits for 200 ms of quiet time, then replaces them with direct ranked API result cards; a result remains navigable even when its note is outside the loaded recent-note pages. Unsupported local source/language filters wait for the server rather than showing incorrect metadata matches. Search can also be focused with `Ctrl-K` or `⌘K`. Selecting a notebook filters both the home list and the sidebar; `Unfiled` means notes whose `notebookId` is `null` and is sent as an explicit search filter. The API selects keyword, semantic, or hybrid retrieval through `auto` mode.

Use the `+` action in the Notebooks section to create a notebook. Names are trimmed, limited to 80 characters, and unique per owner. Open a note and use its notebook selector to move it to a notebook or back to Unfiled. The selector is disabled while an edit is waiting to be saved.

Inside a note, existing notes open in Preview by default. Choose Edit when you want to change Markdown, title, or tags; newly created notes open directly in Edit mode. Edit opens the CodeMirror Markdown editor and Preview renders sanitized Markdown with copy buttons for fenced code and named copy blocks. The note is saved after 800 ms without changes. Open Attachments to upload a supported file, preview it in-app, or choose Screenshot: Visible Area asks the browser for a display/window capture, Entire Page captures the current QNotes page, and Cropped Zone opens an accessible keyboard- and pointer-driven crop selection. Attachment previews request a short-lived signed URL only when opened; Open remains available for the original file, and text previews are capped at 1 MB. Screenshot capture requires browser permission and never uploads until the selected image is explicitly attached; image OCR remains unsupported. Delete is a soft delete that moves the note to the trash; the same note view exposes Restore for a deleted note. Export downloads the current note as `<slug>.md`.

Use Share in an active note to create a read-only public link. Choose a 1-, 7-, 30-, or 90-day lifetime, or no expiry. The raw link is shown once while the dialog is open; close it after copying. Reopening Share shows only a safe prefix and expiry metadata, and lets you rotate or revoke the active link. Creating or rotating a link flushes pending autosave first, so public readers see only saved content. Open `/share#qns_...` to view a link without signing in; the public page renders the same sanitized Markdown preview but never loads attachments, AppShell data, or private note queries.

AI agents can fetch the saved note body directly as Markdown over HTTPS; see [AI_AGENTS_SHARED_LINKS.md](AI_AGENTS_SHARED_LINKS.md) for the endpoint, examples, and bearer-token handling rules. The browser share secret stays in the URL fragment; the API resolver accepts it only in a POST body.

If another device changes a note while a local draft is dirty, the conflict dialog can use the local version, use the remote version, save a manually edited merge, or cancel while retaining the local draft. If the remote note was deleted, the local draft can be saved as a new note.

## Markdown and copyable blocks

Notes accept normalized Markdown with LF line endings. Fenced code blocks are automatically indexed as copyable `code` blocks. A named block uses the following extension:

```markdown
:::copy{id="deploy" title="Deploy" lang="bash" type="command"}
docker compose up -d
:::
```

Named blocks support the `id`, `title`, `lang`, and `type` attributes. `id` is required and must be 1–64 characters matching `[a-z0-9][a-z0-9_-]*`; `title` defaults to the ID, `type` defaults to `copy`, and `lang` is optional. Supported block types are `copy`, `code`, `prompt`, `command`, `sql`, `json`, `yaml`, `env`, `url`, `quote`, and `checklist`.

Named block IDs must be unique within a note. Nested or unclosed named blocks, invalid attributes, invalid types, and unclosed fenced code blocks are rejected with `422`. Markdown HTML is disabled in the renderer. Content is limited to 2,000,000 JavaScript code units.

The parser also derives plain text and search chunks from notes. Chunks are grouped by headings and emitted with an approximate 350-token budget and 40-token overlap for asynchronous embedding work. Attachment chunks use the same token-aware overlap policy; PDF chunks retain page provenance.

## Architecture

- `apps/web` contains the authenticated React/Vite UI, CodeMirror editor, service-worker shell, notebook filters, attachment panel, token settings, public share view, and Realtime/recovery hooks.
- `packages/shared` contains shared contracts, validation, generated database types, and API error codes.
- `packages/markdown` parses and renders Markdown, derives plain text, extracts blocks, chunks content, and computes content hashes.
- `packages/sync` provides the 800 ms autosave coordinator, IndexedDB draft abstractions, and three-way merge support.
- `packages/api-client` is the typed HTTP client used by the web app and CLI. It adds `/api`, sends bearer credentials, unwraps `{ data: ... }`, and raises structured HTTP errors.
- `packages/cli` provides the `qnotes` command-line interface.
- `packages/mcp-server` provides the native read-only MCP server plus an explicit write-tool profile over `@qnotes/api-client`.
- `supabase/functions/qnotes-api` exposes the REST API. Note writes use service-role-only transaction RPCs for optimistic version checks, idempotent mutation IDs, block synchronization, and search-document updates.
- `supabase/functions/embedding-worker` consumes the `note-embeddings` queue. `supabase/functions/attachment-worker` consumes `attachment-processing`, extracts supported files, and indexes attachment chunks.
- `supabase/migrations` defines the `notesdb` schema, RLS, private Storage, pgvector/pgmq/pg_cron integration, Realtime Broadcast trigger, API tokens, notebooks, public note shares, and search relevance indexes.

PostgreSQL full-text and relevance-ranked keyword search is available immediately. Embeddings are generated asynchronously in 384 dimensions with `gte-small` model version `v2`. Every vector records a hash of the exact source title, heading path, and content used to create it; model changes and stale inputs are re-queued instead of being relabeled. Local tests use the explicit `QNOTES_ENVIRONMENT=test`, `QNOTES_FAKE_EMBEDDINGS=1`, and `QNOTES_EMBEDDING_MODE=synthetic-test-v1` identity; production rejects synthetic mode before queue work starts. Worker cron jobs process both queues every 30 seconds in the configured Supabase project, with bounded concurrency and batch draining. Provider timeouts reach a terminal state after five actual provider attempts; queue leases that end before provider work do not consume that budget. The daily `qnotes-requeue-stale-embeddings` job runs at 03:00 UTC (06:00 UTC+03) as a recovery/catch-up schedule for stale embedding work, while `qnotes_requeue_embedding_failures(limit)` is the bounded operator requeue path.

The browser subscribes to the private `user:<user-id>:notes` Realtime channel and receives metadata-only `note.changed` events. IndexedDB stores drafts, a notes sync cursor, and recent authoritative note snapshots. Access tokens are not stored in IndexedDB or the service-worker cache.

CI runs the core typecheck/unit/Edge/build/generated-parity checks, local Supabase SQL/database integration tests, the path-gated search regression job, and the bounded Chromium browser smoke job on GitHub-hosted `ubuntu-latest` runners. The browser smoke covers note navigation and edit/preview, Vault administration routes, public-share rendering, accessibility, and the attachment UI without starting background workers. The complete Playwright E2E suite remains a local/manual command (`pnpm run test:e2e`) and is not run by CI/CD. A successful push to `master` runs the production CD job only after the browser smoke and other enabled release checks pass. Deployment applies migrations, runs the read-only production Vault readiness gate, deploys Supabase Edge Functions, publishes Cloudflare Pages, and verifies the live health endpoints. The readiness gate safely captures the Supabase CLI JSON, examines only the `QNOTES_VAULT_TOKEN_PEPPER` entry by name, ignores any `value` field, and never logs secret values; the pepper is not a GitHub Actions secret. See [.github/GITHUB_ACTIONS.md](.github/GITHUB_ACTIONS.md) for the runner setup and production secrets. The available check names are `CI / core`, `CI / integration`, `CI / search regression`, and `CI / browser smoke`. See [SECURITY.md](SECURITY.md) for the full-history secret-scan and vulnerability-reporting procedure.

## Local development

Prerequisites are Node.js 18 or newer (verified with 24.19.0), pnpm 12.1.0, Deno 2.9.6 or newer (verified with 2.9.6), Docker for local Supabase, and the Supabase CLI. Playwright uses its checked-in `chromium` project with the `Desktop Chrome` device and bundled Chromium; it does not require a separately installed Google Chrome channel.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm exec supabase start
pnpm run local:env
pnpm run seed:test-users
```

`local:env` reads the local Supabase status without printing keys and writes ignored files at `apps/web/.env.local`, `supabase/functions/.env.test`, and `.tmp/local-env.json`. `seed:test-users` is deliberately restricted to a local Supabase URL and creates the E2E accounts used by the test suite. The verification gate never runs either command automatically, never resets or reseeds the database, never regenerates types, and never rewrites environment or lock files.

### Local verification gate

`pnpm run test:edge` discovers every `*.test.ts` file below `supabase/functions/` and passes the explicit file list to Deno with `supabase/functions/deno.json`. It covers both the `Deno.test` and `node:test` registrations currently used by the Edge suite, preserves Deno type checking, and uses `--no-lock` so a stale Deno lockfile cannot be rewritten implicitly. The runner reports the discovered files and Deno's passed-test count; it fails if the directory contains no applicable test files or any test fails.

Run the complete local gate only after the one-time setup above:

```bash
pnpm run verify:local
```

The gate validates Node, pnpm, Deno, installed dependencies, the local Supabase service, ignored environment files, every effective Supabase/API URL, and the configured Chromium browser before it starts any database or E2E operation. It then runs these stages sequentially and stops at the first nonzero result:

1. `pnpm run typecheck`
2. `pnpm run test:unit`
3. `pnpm run test:edge`
4. `pnpm run build`
5. `pnpm run verify:edge-shared`
6. `pnpm exec supabase test db`
7. `pnpm run test:e2e:smoke`

With external mode unset, the local `test:e2e:smoke` command sets `QNOTES_E2E_SERVE_WORKERS=0`, starts Vite and only the local `qnotes-api` function through the smoke config’s bounded `playwright.config.ts` lifecycle, and uses one Chromium worker. CI starts Vite and `qnotes-api` in workflow-managed processes, sets `QNOTES_E2E_EXTERNAL_API=1`, and lets Playwright reuse the workflow-managed Vite process. Playwright reuses an already running server only when it verifies its configured URL. `tests/e2e/global-setup.ts` and the E2E fixture clear application data only for the dedicated local users `owner@qnotes.local` and `other@qnotes.local`; this bounded cleanup is an intentional side effect of E2E setup. The guard does not stop processes it did not start.

If preflight fails, fix the reported local prerequisite manually: install the pinned tools, start Docker/Supabase, run `pnpm run local:env`, seed the dedicated users with `pnpm run seed:test-users`, or install bundled Chromium with `pnpm exec playwright install chromium`. It will reject HTTPS, URL credentials, localhost lookalikes, mismatched local targets, and any inherited remote URL before the database or browser stages. A stage failure is reported with its elapsed time and prevents all later stages from running. This gate is a local correctness and regression check, not a production deployment check or a security audit; production validation remains covered by the deployment and security procedures below.

The real search evaluator lives under `tests/search-evaluation-fixtures.json` and `scripts/evaluate-search.mjs`. Run it against a local API with `QNOTES_URL` and a scoped token; add `--seed` to create its stable dedupe-key corpus. An optional `--results` mode calculates offline metrics but is not product performance. Before committing changes that touch `packages/markdown/`, `supabase/functions/qnotes-api/search.ts`, `supabase/functions/embedding-worker/`, a Supabase search migration, the search fixtures/baseline, or the search evaluation scripts, run `pnpm run verify:search -- --seed` against local Supabase. The regression guard runs the stable evaluator, compares checked-in keyword/semantic/hybrid quality floors, verifies bounded context usefulness and provenance, and enforces local search/context p95 latency caps from `tests/search-evaluation-baseline.json`; it refuses to run when the fixture hash and baseline disagree. The local-only benchmark uses `scripts/seed-search-benchmark.mjs` and `scripts/search-benchmark.mjs`; every run requires `--local-benchmark`, uses the dedicated local benchmark owner, verifies actual row counts, and reports repeated keyword/semantic/hybrid latency and ANN metadata. Query-plan collection uses `scripts/search-query-plans.sql` against a representative database.

The test suite reads its local-only credentials from `tests/e2e/helpers.ts`; do not reuse them outside local testing. For a direct E2E invocation, the same helper enforces the local-only target boundary before setup or test fixtures can make requests.

Run the web app with:

```bash
pnpm dev
```

For manual local API calls, serve the functions in a second terminal. The web app’s generated `VITE_QNOTES_API_URL` points at this function root:

```bash
pnpm exec supabase functions serve qnotes-api embedding-worker attachment-worker \
  --env-file supabase/functions/.env.test --no-verify-jwt
```

Open `http://127.0.0.1:5173`. The local API health check is `http://127.0.0.1:54321/functions/v1/qnotes-api/api/health`. Local Playwright runs manage the API through `playwright.config.ts`; CI starts Vite and the API as bounded workflow-managed processes, sets `QNOTES_E2E_EXTERNAL_API=1`, and lets Playwright reuse Vite.

`db:types` must run against the final local schema. After changing shared contracts or generated database types, run `pnpm run sync:edge` so the Deno functions receive the copies under `supabase/functions/_shared/generated`.

## Database, tests, and deployment

Reset the local database, regenerate types, and run SQL tests with:

```bash
pnpm exec supabase db reset
pnpm run db:types
pnpm run sync:edge
pnpm exec supabase test db
```

The unit suite covers the Markdown, sync, API-client, CLI, and MCP packages:

```bash
pnpm run test:unit
```

The full E2E suite remains available locally/manual with the single-worker, zero-retry configuration in `playwright.config.ts`:

```bash
pnpm run test:e2e
```

For the short release-oriented browser check, use the dedicated smoke command. Locally it starts Vite and only the local `qnotes-api` function; CI starts both processes in the workflow and Playwright reuses Vite. Both paths apply tighter test/action/navigation/global deadlines, and the global setup plus per-test fixture clears application data for the two dedicated local test users:

```bash
pnpm exec playwright install chromium
pnpm run test:e2e:smoke
```

The hosted project is `ciyoandzjezgqxjpcrin`, and the production web site is `https://notes.quadrate.lk`. Before a production deployment, set exact CORS origins and server-only secrets. Do not set `QNOTES_FAKE_EMBEDDINGS=1` in production; hosted workers need the Supabase AI runtime for `gte-small` embeddings.

The hosted database must contain the migrations through `20260910001300_attachment_immutability.sql`. The Agent Vault migrations add the isolated metadata plane, Supabase Vault-backed service-only RPCs, qvt grants, audit/replay protections, bounded batch reveal, and compatibility for unchanged rotates whose receipts use the pre-`expectedVersion` request hash. The public-sharing migrations add the HMAC-backed, service-only public share table, reviewed version-bound immutable snapshots, transactional create/rotate/revoke RPCs, the three-field resolver projection, automatic revocation on soft delete, and the caller-owned `shares:write` personal-token scope; the attachment lifecycle migration adds staged uploads, immutable final objects, digest verification, and retryable deletion cleanup. The preceding migrations add the transaction-safe logical append receipt, request-safe search functions, embedding input/version invariants, stale-vector requeueing, attachment page provenance, safe capture deduplication, and the daily embedding recovery schedule. The worker cron jobs read the project URL and internal worker secret from Supabase Vault, so those Vault secrets and the Edge Function secrets must be configured before expecting asynchronous embeddings or attachment extraction. Before deploying Edge Functions, run `SUPABASE_PROJECT_ID=ciyoandzjezgqxjpcrin pnpm run verify:vault`; it checks the server-only `QNOTES_VAULT_TOKEN_PEPPER` by name and validates the database contract without revealing a value or returning database data.

Deploy the API and worker functions with the repository import map:

```bash
pnpm exec supabase functions deploy qnotes-api embedding-worker attachment-worker qnotes-mcp \
  --project-ref ciyoandzjezgqxjpcrin --no-verify-jwt --use-api \
  --import-map supabase/functions/deno.json
```

Build and deploy the web package to Cloudflare Pages with the hosted Supabase values:

```bash
VITE_SUPABASE_URL=https://ciyoandzjezgqxjpcrin.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=... \
VITE_QNOTES_API_URL=https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api \
pnpm --filter @qnotes/web build

npx wrangler pages deploy apps/web/dist --project-name notes-quadrate-lk
```

## Security and data boundaries

Every exposed application table is protected by owner-based RLS. Browser clients receive only the Supabase publishable key and read through owner-scoped grants; writes, private attachment metadata, token operations, public share operations, and search RPCs are mediated by the Edge Function and service role. Personal tokens and public share secrets are scoped to separate formats and domain-separated HMAC-SHA-256 hashes. Personal tokens are optionally expirable and revocable; public shares are single-active, expirable, revocable, and automatically revoked when a note is soft-deleted. Raw secrets are returned only at creation time; browser share secrets stay in URL fragments, and the unauthenticated API resolver accepts them only in POST bodies, never query strings or logs.

Set `QNOTES_ALLOWED_ORIGIN` to an exact comma-separated allow-list and keep Realtime “Allow public access” disabled. Keep `QNOTES_TOKEN_PEPPER`, `QNOTES_INTERNAL_WORKER_SECRET`, `QNOTES_VAULT_TOKEN_PEPPER`, and `SUPABASE_SERVICE_ROLE_KEY` server-side. Keep attachment and export limits aligned with the desired deployment; the local defaults are 20 MiB per attachment and 50 MiB per workspace ZIP.

Autosave-level synchronization deliberately stops short of character-level collaboration. Shared cursors, CRDTs, operational transformation, team workspaces, public multi-note publishing, native apps, image OCR, and a large offline write queue are outside the current product boundary. Public sharing is limited to one explicitly shared note at a time and never includes attachments.

## API and CLI quick start

Create a scoped personal token at `/settings/integrations` (the legacy `/settings/tokens` route remains available), then configure a client with the Edge Function root (without `/api`):

```bash
pnpm --filter @qnotes/api-client build
pnpm --filter @qnotes/cli build

export QNOTES_URL=http://127.0.0.1:54321/functions/v1/qnotes-api
export QNOTES_TOKEN=qnt_your_scoped_token

pnpm --filter @qnotes/cli exec node dist/index.js search "ERPNext docker" --hybrid
pnpm --filter @qnotes/cli exec node dist/index.js get erpnext-production --raw
pnpm --filter @qnotes/cli exec node dist/index.js blocks erpnext-production
pnpm --filter @qnotes/cli exec node dist/index.js block get erpnext-production production-deploy
pnpm --filter @qnotes/cli exec node dist/index.js notebooks
pnpm --filter @qnotes/cli exec node dist/index.js notebook create "Operations"
pnpm --filter @qnotes/cli exec node dist/index.js notebook move erpnext-production <notebook-id>
pnpm --filter @qnotes/cli exec node dist/index.js capture "Remember to rotate the staging key"
pnpm --filter @qnotes/cli exec node dist/index.js append erpnext-production "Confirm the release"
pnpm --filter @qnotes/cli exec node dist/index.js export --workspace --output notes-backup.zip --force
```

Workspace backups can be validated first and then explicitly restored through the API. The restore creates new owner-scoped identities, preserves Markdown, tags, notebooks, and private attachments, rejects conflicts instead of overwriting existing data, and can be retried safely with the same archive. Current version-two backups are supported, and the importer also safely normalizes the repository's legacy pre-v2 backup format (which has no notebook relationships); malformed or unsupported manifests are rejected rather than guessed:

```bash
curl -fsS -X POST -H "Authorization: Bearer $QNOTES_TOKEN" -H 'Content-Type: application/zip' \
  --data-binary @notes-backup.zip "$QNOTES_URL/api/import/workspace" > restore-plan.json
# Review restore-plan.json and continue only when ready=true and conflicts=[]
curl -fsS -X POST -H "Authorization: Bearer $QNOTES_TOKEN" -H 'Content-Type: application/zip' \
  --data-binary @notes-backup.zip "$QNOTES_URL/api/import/workspace?confirm=true"
```

The CLI uses native `fetch`, never connects directly to PostgreSQL, and does not automatically retry failed requests. Mutation requests carry UUID `deviceId`, UUID `mutationId`, and (for updates) `expectedVersion`; the append command uses the logical append endpoint rather than rewriting a fetched whole document. For complete REST, retry-identity, JavaScript-client, and Hermes examples, read [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md).

## Agent Vault

QNotes Agent Vault is an isolated credential plane for agent workflows. It
uses `qvt_` tokens, Supabase Vault-backed encrypted values, scoped grants,
service-only RPCs, committed reveal audits, expected-version writes, and
replay-safe mutation IDs. Vault values are never part of Notes search,
embeddings, logs, browser persistence, public shares, or workspace backups.

Production readiness is checked separately from application health. After the
Vault migrations are applied, run `pnpm run verify:vault` with
`SUPABASE_PROJECT_ID` and the existing Supabase CLI authentication. The check
safely captures the secrets-list JSON, examines only each entry's `name` to
confirm that `QNOTES_VAULT_TOKEN_PEPPER` exists, ignores any `value` field, and
never logs secret values. It then uses a linked read-only database query whose
result contains booleans only for
the extension, schema, metadata tables, current service-only RPCs, and
`anon`/`authenticated` denial plus `service_role` execute privileges. It fails
on a missing pepper, unavailable command, malformed output, or any false
check. It does not reveal, create, rotate, or mutate credentials and is not a
public health route.

Native MCP callers opt in with `QVAULT_TOKEN` and
`QVAULT_MCP_PROFILE=metadata|reveal|write`; the Integrations page can add
those as placeholders to the same generated Hermes server entry, while the
raw qvt token is supplied separately. Vault requests use the required
`QNOTES_URL` and a non-empty `QVAULT_URL` is rejected. The hosted HTTP MCP
endpoint stays Notes-only. See [VAULT_ACCESS_GUIDE.md](VAULT_ACCESS_GUIDE.md)
for the route, grant, and secret-handling contract.
