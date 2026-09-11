---
name: qnotes-security-review
description: Review QNotes trust boundaries, authorization, Vault isolation, and data privacy.
---

# QNotes security review

Review the complete request path, including browser state, Edge Functions, database policies, storage, logs, search, embeddings, shares, and backups.

- Confirm authentication, project or notebook scope, ownership, and authorization are checked at the server boundary.
- Confirm Vault plaintext stays out of Notes search, embeddings, logs, browser persistence, public shares, and workspace backups.
- Confirm attachment access remains private and digest or lifecycle checks are preserved.
- Confirm public-share and token flows do not disclose private metadata or credentials.
- Confirm untrusted MCP and API inputs have strict bounds and outputs do not expose internal data.
- Prefer database constraints and existing shared helpers over duplicate application checks.

Use synthetic credentials and loopback Docker Supabase for verification. Do not add secrets to fixtures, snapshots, documentation, or commits.
