# Vault step-up and recovery

QNotes treats Vault metadata and Vault values as separate surfaces. Listing projects, environments, secret metadata, agent-token metadata, and audit history uses the authenticated human session. For human Supabase sessions, revealing a value, creating or changing a secret, issuing or revoking an agent token, and replacing grants require a verified `aal2` session and a single-use approval. Granted `qvt_` agent credentials remain constrained by their stored grant and do not use the human step-up flow.

The approval flow is deliberately short:

1. The browser completes a Supabase MFA challenge with a verified factor.
2. QNotes verifies the JWT signature, issuer, audience, expiry, user, session, assurance level, and recent MFA timestamp on the server. Refresh time is not treated as MFA time.
3. QNotes issues an approval bound to the user session, exact action, resource identifiers, expected version, and SHA-256 request digest.
4. The browser sends that approval with the operation. The database consumes it under a row lock and rejects replay, expiry, changed resources, changed versions, or changed request bodies.

Step-up freshness is five minutes. An operation approval is valid for sixty seconds and can be consumed once. A missing factor, an `aal1` session, an old MFA event, or a malformed claim fails closed with no reveal.

New `qvt_` agent credentials must carry a future expiry no greater than the configured `notesdb.vault_security_policy.max_agent_token_lifetime_seconds` value. The checked-in staging policy is ninety days. Missing policy configuration rejects issuance. Existing non-expiring credentials are retained for staged reissuance and are not silently revoked by this change.

If a factor is lost, stop using the affected session and have an authorized operator follow the identity provider's recovery and factor re-enrollment process. QNotes does not provide a hidden recovery header, generic proxy, shell command, or plaintext export path. Recovery approval belongs in the identity-provider and operator audit trail; once a new verified factor is enrolled, the user can complete the normal step-up flow and existing Vault values remain available.

Approval and agent tokens are never persisted in browser storage or included in QNotes audit rows. The one-time agent token is shown only in the creation response; copy it to the intended secret manager before closing the page.
