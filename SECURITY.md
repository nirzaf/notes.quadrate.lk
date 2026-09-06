# Security Policy

## Supported versions

The `master` branch is the maintained security target. Security fixes should be reviewed against the deployed Supabase Edge Functions and the web bundle built from the same commit.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's Security Advisories / Private Vulnerability Reporting for this repository. Include the affected commit or endpoint, a minimal reproduction, impact, and any relevant request IDs. Do not include real note content, personal data, access tokens, service-role keys, or other secrets in an issue, pull request, log, or reproduction archive.

If a credential may have been exposed, revoke or rotate it first and then report the exposure privately. Public disclosure should wait until a fix and coordinated release are available.

## Secret and visibility checks

Before changing repository visibility or publishing a mirror, scan the complete reachable Git history and the working tree with a current Gitleaks release:

```bash
gitleaks git --redact --log-opts="--all"
gitleaks dir --redact --no-banner .
```

The first command scans reachable history; the second scans the current working tree, including ignored local files. Run both from a fresh clone before changing visibility.

The checked-in `.gitleaks.toml` only allow-lists the synthetic `qns_Abcd1234` fixture value in its exact test file; do not broaden that exception for real credentials.

Also review ignored and untracked files (`git ls-files --others --ignored --exclude-standard`), GitHub Actions logs and artifacts, deployment configuration, author metadata, binary blobs, and historical branches/tags. Treat any finding as compromised until the credential is revoked and the affected history is assessed. Never paste the finding's secret value into a ticket.

## Operational safeguards

Keep `SUPABASE_SERVICE_ROLE_KEY`, `QNOTES_TOKEN_PEPPER`, worker secrets, and personal API tokens server-side. Use least-privilege token scopes, exact local-target checks for tests, and the repository's fail-fast verification pipeline before release. Public share secrets belong in URL fragments or POST bodies only; they must not be placed in query strings or logs.

Workspace backup imports must be dry-run first and explicitly confirmed. The current endpoint is validation-only and fails closed for mutation; do not restore an untrusted archive or bypass archive size, file-count, path, manifest, attachment-byte, or owner-conflict checks. A future mutating restore must re-check owner conflicts immediately before enabling writes.
