# Security policy

QNotes is a self-hostable application. Operators are responsible for the
Supabase, frontend-hosting, OAuth, and secret-management configuration used by
their deployment.

## Supported versions

The current `master` branch is the maintained security target. Security fixes
should be reviewed against the Edge Functions and frontend built from the same
commit. Pin a reviewed commit when deploying a release.

## Reporting a vulnerability

Report suspected vulnerabilities privately through the repository's GitHub
Security Advisories or Private Vulnerability Reporting channel. Include the
affected commit or route, a minimal reproduction, impact, and any request IDs.

Do not include real note content, personal data, access tokens, service-role
keys, Vault values, or other secrets in an issue, pull request, log, or
reproduction archive.

If a credential may have been exposed, revoke or rotate it first and then
report the exposure privately. Public disclosure should wait until a fix and a
coordinated release are available.

## Before publishing a repository

Before changing repository visibility or publishing a mirror, run a current
Gitleaks release from a fresh clone:

```bash
gitleaks git --redact --log-opts="--all"
gitleaks dir --redact --no-banner .
```

The first command scans reachable history. The second scans the working tree,
including ignored local files. Also review:

- ignored and untracked files from `git ls-files --others --ignored --exclude-standard`;
- GitHub Actions logs and artifacts;
- deployment configuration and workflow environment values;
- author metadata, binary files, branches, and tags.

Treat every finding as compromised until the credential is revoked and the
affected history is assessed. Never paste a finding's secret value into a
ticket or commit.

The checked-in `.gitleaks.toml` allow-list is limited to the synthetic
`qns_Abcd1234` fixture in its exact test file. Do not broaden it for real
credentials or example values that resemble real credentials.

## Application boundaries

Keep these values server-side:

- `SUPABASE_SERVICE_ROLE_KEY`;
- `QNOTES_TOKEN_PEPPER`;
- `QNOTES_VAULT_TOKEN_PEPPER`;
- `QNOTES_INTERNAL_WORKER_SECRET`;
- personal `qnt_...` and Agent Vault `qvt_...` tokens.

The Supabase publishable key may be embedded in the browser build, but it does
not replace a server credential and must not be confused with the service-role
key. Set `QNOTES_ALLOWED_ORIGIN` to an exact allow-list and keep Realtime public
access disabled.

Public-share `qns_...` values are bearer secrets. Keep them in URL fragments
or POST bodies only; never put them in query strings, logs, referrers, or
analytics payloads. Public shares expose one saved note's title and Markdown
body and never expose attachments or workspace metadata. Sharing publishes one
immutable snapshot of a reviewed note version and the server refuses
credential-like content with `PUBLIC_SHARE_SENSITIVE`, so a later edit cannot
silently publish new material through an existing link.

Request bodies are capped before parsing (8 MiB for `/api/*`, 1 KiB for the
public resolver, and 272 KiB for `/vault/*`), and costly operations consume a
per-principal budget that fails closed with `429 RATE_LIMITED` or
`503 RESOURCE_LIMIT_UNAVAILABLE`. Attachment bytes are staged, verified against
their declared size, signature, and SHA-256 digest, and then promoted to
immutable storage instead of being overwritten in place.

Agent Vault is a separate data plane. Vault plaintext must not enter Notes
search, embeddings, logs, browser persistence, public shares, realtime note
payloads, or workspace backups. Reveal requires an explicit purpose and places
the value in the requesting agent's context.

Workspace imports must be dry-run first and explicitly confirmed with
`confirm=true`. The importer rejects owner conflicts instead of overwriting
existing data, checks archive and attachment limits, uses stable identities for
retries, and keeps attachments in private Storage. API tokens, public-share
tokens, mutation receipts, vectors, and queue state are never restored.

For deployment-specific checks, see [deployment.md](deployment.md). For the
Vault contract, see [VAULT_ACCESS_GUIDE.md](VAULT_ACCESS_GUIDE.md).
