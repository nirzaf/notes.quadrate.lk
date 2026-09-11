# QNotes repository rule

- Treat current code, shared contracts, migrations, and generated Edge copies as the source of truth.
- Keep changes small and use the existing pnpm workspace, dependencies, and coding style.
- Use Node.js 18+, pnpm 12.1.0, and Deno 2.9.6 or newer. Run focused checks first, then the repository gate that matches the change.
- After changing shared source, run `pnpm run sync:edge` and `pnpm run verify:edge-shared`.
- Use the loopback Docker Supabase stack for local database and browser verification. Never reset or migrate a production database from a local workflow.
- Keep Vault and Notes separate: Vault plaintext must not enter Notes search, embeddings, logs, browser storage, public shares, or backups.
- Validate every untrusted boundary, preserve attachment privacy and share-token rules, and keep authorization enforced by the existing server and database patterns.
- Tracked Markdown is public documentation. Use placeholders for domains, project IDs, account names, and credentials.
- Use clean worktrees for concurrent work, short imperative Conventional Commit subjects, and pull requests targeting the repository default branch.
