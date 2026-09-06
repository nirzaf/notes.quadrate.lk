# Repository Guidelines

## Project Structure

This is a pnpm monorepo. The React/Vite PWA lives in `apps/web/`. Shared contracts and generated database types are in `packages/shared/`; Markdown processing, synchronization, the API client, CLI, and native MCP server are in `packages/markdown/`, `packages/sync/`, `packages/api-client/`, `packages/cli/`, and `packages/mcp-server/`. Supabase Edge Functions are under `supabase/functions/`, SQL migrations under `supabase/migrations/`, and database tests under `supabase/tests/`. Node tests are colocated in package `test/` directories and `scripts/test/`; Playwright specs and fixtures are in `tests/e2e/`.

## Build, Test, and Development Commands

Use Node.js 18+, pnpm 12.1.0, and Deno 2.9.6+.

- `pnpm install --frozen-lockfile` installs the workspace without changing the lockfile.
- `pnpm dev` starts the web app; `pnpm run build` builds all packages and verifies generated Edge parity.
- `pnpm run typecheck` checks every workspace package.
- `pnpm run test:unit` runs Node and package tests; `pnpm run test:edge` runs every `supabase/functions/**/*.test.ts` file through the checked-in Deno import map.
- `pnpm run verify:local` performs preflight, then runs the verification gate. It requires Docker/Supabase, ignored env files, and Chromium. Run `pnpm run verify:search -- --seed` before changes under `packages/markdown/`, `supabase/functions/qnotes-api/search.ts`, `supabase/functions/embedding-worker/`, search migrations, fixtures/baselines, or search evaluation scripts.
- After changing shared source, run `pnpm run sync:edge` and then `pnpm run verify:edge-shared`. Run focused E2E with `pnpm exec playwright test tests/e2e/navigation.spec.ts tests/e2e/accessibility.spec.ts --project=chromium`; accessibility coverage uses axe without broad suppressions.

## Coding and Testing Conventions

Use strict TypeScript with two-space indentation, semicolons, single-quoted imports/strings, and descriptive camelCase functions; use PascalCase for React components and types. Follow existing ESM/import-map patterns. Name Node tests `*.test.mjs`, Deno tests `*.test.ts`, Playwright tests `*.spec.ts`, and SQL tests `*.test.sql`. No repository formatter or linter script is declared, so keep changes consistent with nearby code.

## Commits and Pull Requests

Use short imperative Conventional Commit-style subjects such as `feat: ...`, `fix: ...`, or `chore: ...`. Pull requests should describe behavior and affected packages, list verification commands, call out migrations or deployment impact, and include screenshots for UI changes when useful. Keep generated Edge copies synchronized with their source.

## Security and Configuration

Never commit tokens, service-role keys, production Vite values, or ignored `.env` files. Local E2E setup is restricted to loopback Supabase and dedicated test users. Do not run database resets against production; follow `deployment.md` for linked migrations and releases. Run the full-history scan in `SECURITY.md` before visibility changes. Workspace backup imports require a dry run followed by explicit `confirm=true`, reject conflicts without overwriting existing data, use stable retry identities, and keep attachments private.
