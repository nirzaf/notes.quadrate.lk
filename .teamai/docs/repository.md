# QNotes repository map

QNotes is a pnpm monorepo. The React/Vite PWA is in `apps/web/`. Shared contracts and generated database types are in `packages/shared/`. Markdown processing, synchronization, the API client, CLI, and native MCP server are in `packages/markdown/`, `packages/sync/`, `packages/api-client/`, `packages/cli/`, and `packages/mcp-server/`.

Supabase Edge Functions live in `supabase/functions/`, SQL migrations in `supabase/migrations/`, and database tests in `supabase/tests/`. Node tests are colocated in package `test/` directories and `scripts/test/`; browser tests are in `tests/e2e/`.

Notes and Vault are separate planes. Notes handles qnt, qns, and regular note behavior. Vault handles encrypted values through service-only RPCs and must not expose plaintext to Notes features or persisted client data.
