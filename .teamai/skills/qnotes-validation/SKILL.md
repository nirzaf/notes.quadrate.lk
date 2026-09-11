---
name: qnotes-validation
description: Validate QNotes changes with the smallest relevant local checks and Docker Supabase.
---

# QNotes validation

Apply this skill when changing QNotes application code, packages, Edge Functions, migrations, or browser behavior.

1. Classify the change and run its focused test first.
2. Use the loopback Docker Supabase stack for database and E2E checks.
3. Run `pnpm run typecheck`, `pnpm run test:unit`, and `pnpm run test:edge` for cross-package or Edge changes.
4. Run `pnpm run verify:search -- --seed` for search, indexing, embedding, or Markdown changes.
5. Run `pnpm run sync:edge` and `pnpm run verify:edge-shared` after shared source changes.
6. Run `pnpm run verify:local` before handing off a broad change.

Stop on a failed check and report the command and first actionable error. Never use production credentials or reset a production database during local validation.
