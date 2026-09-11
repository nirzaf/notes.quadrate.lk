# QNotes production hardening evidence

This release record maps every audit finding to its implementation issue and
behavioral evidence. A green build is not a production security claim.

## Release identity

| Field | Value |
| --- | --- |
| Repository | `nirzaf/qnotes` |
| Candidate base | `master` |
| Candidate head | `ea2d0e3` (US-28 recorded in [PR #119](https://github.com/nirzaf/qnotes/pull/119)); later documentation-only commits may advance the tip |
| Verification environment | Self-hosted Supabase running through Docker on loopback |
| Data boundary | The existing data-bearing local stack is preserved; no reset or production data migration is performed by this program |
| Credential boundary | Synthetic test credentials only; no production secret movement, revocation, permission cutover, or deployment |

## Gate record

Run these gates against the final candidate and record the exact commit in the
release identity above. A skipped gate stays visible as unavailable.

Set `SUPABASE_DB_CONTAINER` to the local Docker database container before
running the query-plan command. Do not commit a machine-specific container
name or hosted project reference in this report.

| Gate | Command or workflow job | Result | Evidence |
| --- | --- | --- | --- |
| Type contracts | `pnpm run typecheck` / `core` | `TBD` | Workspace TypeScript checks |
| Unit behavior | `pnpm run test:unit` / `core` | `TBD` | Node, package, and plugin tests |
| Edge behavior and parity | `pnpm run test:edge`, `pnpm run verify:edge-shared` / `core` | `TBD` | Deno Edge tests and generated-source comparison |
| Build | `pnpm run build` / `core` | `TBD` | Workspace build and parity |
| Migrated SQL and RLS | `pnpm run verify:local` / `integration` | `TBD` | Self-hosted Docker database; no reset |
| Search quality and plans | `pnpm run verify:search -- --seed`, `docker exec -i "$SUPABASE_DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < scripts/search-query-plans.sql` / `search regression` | `TBD` | Seeded local regression, relevance floors, bounded latency, and checked-in query plans |
| Browser release smoke | `pnpm run test:e2e:smoke` / `browser smoke` | `TBD` | `tests/e2e/release-smoke.spec.ts` only: release navigation, Vault shell, public rendering, login accessibility, and attachment panel |
| Focused browser security | `pnpm exec playwright test tests/e2e/accessibility.spec.ts tests/e2e/auth.spec.ts tests/e2e/attachments.spec.ts tests/e2e/notebooks.spec.ts tests/e2e/notes.spec.ts tests/e2e/oauth-replay.spec.ts tests/e2e/public-sharing.spec.ts tests/e2e/search.spec.ts tests/e2e/tokens-cli.spec.ts tests/e2e/vault-browser-safety.spec.ts tests/e2e/vault.spec.ts --project=chromium` (manual; no CI job) | `unavailable` | Focused accessibility, auth, notebook, note editing, search, token/share, attachment privacy, OAuth replay, and Vault secret-safety coverage |
| Browser recovery round-trip | `pnpm exec playwright test tests/e2e/workspace-recovery.spec.ts --project=chromium` (manual; no CI job) | `unavailable` | Dry-run safety, conflicts, private attachments, token/share exclusion, and retry idempotency |
| Vault readiness | `pnpm run verify:vault` | `TBD` | Synthetic readiness checks and documented isolation residual |
| Tenant vector recall | `pnpm run measure:search-recall -- --local-recall --owner-id <uuid>` (manual; no CI job) | `unavailable` | Uses the checked-in `scripts/measure-tenant-vector-recall.mjs` probe; it requires local provider-backed 384-dimensional embeddings for the named owner, so synthetic vectors do not support a semantic quality claim |
| Workflow aggregation | `release gate` | `TBD` | Required job names and results are recorded from GitHub |

## Finding-to-evidence matrix

Each row is an explicit disposition. `Implemented` identifies the story PR;
the gate record above determines whether the behavior is verified for a final
release candidate. Every path below is a file in this checkout; a historical
PR link does not make an unmerged PR's files part of this candidate.

| Finding / story | Disposition and implementation | Focused behavioral evidence |
| --- | --- | --- |
| US-01 / [#63](https://github.com/nirzaf/qnotes/issues/63) | Implemented in [PR #91](https://github.com/nirzaf/qnotes/pull/91) | `packages/sync/test/diff3.test.mjs` — order-independent merges and expanded overlap regions |
| US-02 / [#64](https://github.com/nirzaf/qnotes/issues/64) | Implemented in [PR #92](https://github.com/nirzaf/qnotes/pull/92) | `packages/sync/test/draft-reconciliation.test.mjs`; `tests/e2e/workspace-recovery.spec.ts` |
| US-03 / [#65](https://github.com/nirzaf/qnotes/issues/65) | Implemented in [PR #98](https://github.com/nirzaf/qnotes/pull/98); isolation remains residual | `scripts/test/vault-readiness.test.mjs`; `VAULT_ISOLATION_DECISION.md` |
| US-04 / [#66](https://github.com/nirzaf/qnotes/issues/66) | Implemented in [PR #99](https://github.com/nirzaf/qnotes/pull/99) | `supabase/tests/0016_agent_vault_atomic_authorization.test.sql` — allowed and denied race paths |
| US-05 / [#67](https://github.com/nirzaf/qnotes/issues/67) | Implemented in [PR #100](https://github.com/nirzaf/qnotes/pull/100) | `supabase/tests/0017_vault_step_up_auth.test.sql`; `packages/shared/test/vault.test.mjs` |
| US-06 / [#68](https://github.com/nirzaf/qnotes/issues/68) | Implemented in [PR #102](https://github.com/nirzaf/qnotes/pull/102); constrained adapter deferred | `supabase/tests/0013_agent_vault_batch_reveal.test.sql`; `tests/e2e/vault-browser-safety.spec.ts` |
| US-07 / [#69](https://github.com/nirzaf/qnotes/issues/69) | Implemented in [PR #93](https://github.com/nirzaf/qnotes/pull/93) | `packages/api-client/test/client.test.mjs`; `integrations/hermes-plugin/tests/test_launch.mjs` |
| US-08 / [#70](https://github.com/nirzaf/qnotes/issues/70) | Implemented in [PR #104](https://github.com/nirzaf/qnotes/pull/104) | `supabase/tests/0010_public_note_sharing.test.sql`; `tests/e2e/public-sharing.spec.ts` |
| US-09 / [#71](https://github.com/nirzaf/qnotes/issues/71) | Implemented in [PR #103](https://github.com/nirzaf/qnotes/pull/103) | `supabase/tests/0019_notebook_scoped_access.test.sql`; `tests/e2e/notebooks.spec.ts` |
| US-10 / [#72](https://github.com/nirzaf/qnotes/issues/72) | Implemented in [PR #105](https://github.com/nirzaf/qnotes/pull/105) | `supabase/tests/0005_realtime_and_storage.test.sql`; `tests/e2e/attachments.spec.ts` |
| US-11 / [#73](https://github.com/nirzaf/qnotes/issues/73) | Implemented in [PR #94](https://github.com/nirzaf/qnotes/pull/94) | `supabase/tests/0007_search_hardening.test.sql` — attachment search preservation and repair bounds |
| US-12 / [#74](https://github.com/nirzaf/qnotes/issues/74) | Implemented in [PR #95](https://github.com/nirzaf/qnotes/pull/95) | `supabase/tests/0014_request_budgets.test.sql`; `supabase/functions/_shared/request-body.test.ts` |
| US-13 / [#75](https://github.com/nirzaf/qnotes/issues/75) | Implemented in [PR #101](https://github.com/nirzaf/qnotes/pull/101) | `supabase/tests/0018_vault_audit_integrity.test.sql` — append-only, export, retry, and denial paths |
| US-14 / [#76](https://github.com/nirzaf/qnotes/issues/76) | Implemented in [PR #96](https://github.com/nirzaf/qnotes/pull/96) | `packages/mcp-server/test/server.test.mjs`; generated Edge parity |
| US-15 / [#77](https://github.com/nirzaf/qnotes/issues/77) | Implemented in [PR #114](https://github.com/nirzaf/qnotes/pull/114) | `packages/mcp-server/test/server.test.mjs`; `packages/api-client/test/client.test.mjs` |
| US-16 / [#78](https://github.com/nirzaf/qnotes/issues/78) | Implemented in [PR #116](https://github.com/nirzaf/qnotes/pull/116) | `supabase/tests/0016_agent_vault_atomic_authorization.test.sql`; `tests/e2e/vault.spec.ts` — current checked-in grant allow/deny coverage |
| US-17 / [#79](https://github.com/nirzaf/qnotes/issues/79) | Implemented in [PR #112](https://github.com/nirzaf/qnotes/pull/112) | `packages/api-client/test/vault-client.test.mjs`; `tests/e2e/vault.spec.ts` — current checked-in replay-safe rotation coverage |
| US-18 / [#80](https://github.com/nirzaf/qnotes/issues/80) | Implemented in [PR #115](https://github.com/nirzaf/qnotes/pull/115) | `packages/sync/test/draft-reconciliation.test.mjs`; `tests/e2e/notes.spec.ts` — current checked-in draft and edit coverage |
| US-19 / [#81](https://github.com/nirzaf/qnotes/issues/81) | Implemented in [PR #109](https://github.com/nirzaf/qnotes/pull/109) | `integrations/hermes-plugin/tests/test_launch.mjs`; `packages/shared/test/hermes.test.mjs` |
| US-20 / [#82](https://github.com/nirzaf/qnotes/issues/82) | Implemented in [PR #113](https://github.com/nirzaf/qnotes/pull/113) | `supabase/tests/0011_oauth_authorization_code.test.sql`; `tests/e2e/oauth-replay.spec.ts` |
| US-21 / [#83](https://github.com/nirzaf/qnotes/issues/83) | Implemented in [PR #106](https://github.com/nirzaf/qnotes/pull/106) | `supabase/tests/0007_search_hardening.test.sql`; `tests/e2e/search.spec.ts` — current checked-in search fallback and isolation coverage |
| US-22 / [#84](https://github.com/nirzaf/qnotes/issues/84) | Implemented in [PR #108](https://github.com/nirzaf/qnotes/pull/108) | `supabase/tests/0007_search_hardening.test.sql`; `scripts/search-query-plans.sql` — current checked-in search and plan evidence |
| US-23 / [#85](https://github.com/nirzaf/qnotes/issues/85) | Implemented in [PR #117](https://github.com/nirzaf/qnotes/pull/117) | `scripts/evaluate-search.mjs`; `scripts/measure-tenant-vector-recall.mjs`; `tests/search-evaluation-fixtures.json` — the tenant recall probe is checked in but still needs a provider-backed local fixture |
| US-24 / [#86](https://github.com/nirzaf/qnotes/issues/86) | Implemented in [PR #111](https://github.com/nirzaf/qnotes/pull/111) | `supabase/tests/0014_request_budgets.test.sql`; `scripts/test/measurement.test.mjs` |
| US-25 / [#87](https://github.com/nirzaf/qnotes/issues/87) | Implemented in [PR #118](https://github.com/nirzaf/qnotes/pull/118) | `scripts/test/embedding-validation.test.mjs`; `supabase/functions/embedding-worker/adapter.test.ts` — current checked-in embedding input coverage |
| US-26 / [#88](https://github.com/nirzaf/qnotes/issues/88) | Implemented in [PR #97](https://github.com/nirzaf/qnotes/pull/97) | `supabase/tests/0015_embedding_retry_isolation.test.sql`; `scripts/test/embedding-validation.test.mjs` |
| US-27 / [#89](https://github.com/nirzaf/qnotes/issues/89) | Implemented in [PR #110](https://github.com/nirzaf/qnotes/pull/110) | `scripts/test/sync-recovery.test.mjs`; `tests/e2e/workspace-recovery.spec.ts` |
| US-28 / [#90](https://github.com/nirzaf/qnotes/issues/90) | This release record and its completeness check | `scripts/verify-hardening-evidence.mjs`; this matrix and the final gate record |

## Behavioral authorization matrix

The migrated-schema tests referenced above must execute both an allowed and a
denied operation where the story changes authorization. The final gate records
the run and its commit.

| Principal and operation | Allowed evidence | Denied evidence |
| --- | --- | --- |
| Anonymous caller → Notes, Vault, token, and public resolver | Public resolver tests in `supabase/tests/0010_public_note_sharing.test.sql` | RLS, Vault privilege, and token tests in `supabase/tests/0002_rls.test.sql`, `supabase/tests/0012_agent_vault.test.sql`, and `supabase/tests/0019_notebook_scoped_access.test.sql` |
| Owner → owned note, attachment, notebook, and share | `supabase/tests/0019_notebook_scoped_access.test.sql`; `supabase/tests/0005_realtime_and_storage.test.sql`; browser suites | Cross-notebook, deleted-resource, and stale-version cases in the same suites |
| Other owner → private note or attachment | `supabase/tests/0002_rls.test.sql`; `supabase/tests/0019_notebook_scoped_access.test.sql` | RLS and notebook grant denial assertions |
| Restricted Notes token → granted notebook | `supabase/tests/0019_notebook_scoped_access.test.sql` | Unfiled, other-notebook, and revoked-token assertions |
| Restricted Vault agent → exact resource/action | `supabase/tests/0016_agent_vault_atomic_authorization.test.sql`; `tests/e2e/vault.spec.ts` | Missing grant, wrong resource, expired, and revoked assertions |
| Service runtime → bounded maintenance operation | Request, embedding, audit, and mutation receipt tests | Client-role `has_function_privilege` denials and bounded input failures |

## Residual risks and unavailable evidence

- Vault isolation remains residual. The current Supabase Vault deployment remains in the same project/runtime.
  Current privilege and broker checks are recorded, while a separately
  administered Vault project and credential boundary remain an open residual
  risk. This report does not call Vault production-ready while that boundary is
  open.
- Constrained adapter deferred. A concrete secret-use adapter remains deferred. Reveal flows are hardened and
  fail closed; no generic proxy, shell, unrestricted file writer, or echoable
  upstream response is introduced.
- Production secret migration, revocation, permission cutover, deployment, and
  irreversible recovery actions are outside this code-only program.
- A disconnected browser can retain already-cached local data until it
  reconnects. The offline cache is account-specific and bounded, but remote
  deletion cannot reach a disconnected device.
- Real-provider recall and latency evidence requires a staging fixture with
  ready provider embeddings. Synthetic vectors are structural-test data and are
  excluded from semantic quality claims.
- Staging rehearsal evidence for encrypted backup restore, credential rotation,
  audit export recovery, and incident disablement is unavailable until a named
  operator supplies a disposable staging target. The release must retain this
  as `unavailable` rather than treating deterministic CI as a rehearsal.

## Staging evidence template

Complete this table only with redacted metadata and a named staging target.
Never put plaintext secrets, bearer tokens, or full environment output here.

| Rehearsal | Target / operator | Evidence ID | Result | Recovery note |
| --- | --- | --- | --- | --- |
| Encrypted backup restore | `TBD` | `TBD` | `unavailable` | Requires disposable staging database and redacted restore log |
| Least-privilege credential rotation | `TBD` | `TBD` | `unavailable` | Requires staged role map and post-rotation access check |
| Audit-export recovery | `TBD` | `TBD` | `unavailable` | Requires redacted export checksum and replay checkpoint |
| Incident disablement | `TBD` | `TBD` | `unavailable` | Requires staged disable switch and re-enable approval |

Run `node scripts/verify-hardening-evidence.mjs` before changing the final
candidate status. The check confirms that all 28 rows and the required
limitations remain present; it does not replace the behavioral gates.
