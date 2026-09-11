# Local development

Install the pinned workspace dependencies with:

```sh
pnpm install --frozen-lockfile
```

Run Supabase through the local Docker stack and use loopback endpoints for development and E2E. Keep local values in ignored environment files; shared documentation must use placeholders such as `${SUPABASE_PROJECT_ID}` and `http://127.0.0.1:54321`.

Useful checks:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run test:edge
pnpm run build
pnpm run verify:local
```

For search or search-adjacent changes, run `pnpm run verify:search -- --seed`. For shared source changes, run `pnpm run sync:edge` followed by `pnpm run verify:edge-shared`. Do not put service keys, Vault peppers, production URLs, or user data in fixtures, commits, or documentation.
