import { createClient } from '@supabase/supabase-js';
import { test, expect } from './test-fixtures';
import { apiJson, localEnv, signInSession } from './helpers';

function data(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || !('data' in body) || !body.data || typeof body.data !== 'object') throw new Error(`Invalid API response: ${JSON.stringify(body)}`);
  return body.data as Record<string, unknown>;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

test('dynamic OAuth registration completes PKCE and rejects authorization-code replay', async () => {
  const env = await localEnv();
  const session = await signInSession();
  const created = await apiJson('/api/tokens', session.access_token, {
    method: 'POST',
    body: JSON.stringify({ name: `oauth-e2e-${crypto.randomUUID()}`, scopes: ['notes:read'], expiresAt: null }),
  });
  const qnotesToken = String(data(created.body).token);
  const mcpUrl = `${env.supabaseUrl}/functions/v1/qnotes-mcp`;
  const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/qnotes-e2e';
  const registration = await fetch(`${mcpUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'E2E' }),
  });
  expect(registration.status).toBe(201);
  const registrationBody = await registration.json() as { client_id?: string };
  expect(registrationBody.client_id).toEqual(expect.any(String));

  const verifier = 'A'.repeat(64);
  const challenge = await pkceChallenge(verifier);
  const state = 'oauth-e2e-state';
  const authorizationForm = new URLSearchParams({
    client_id: registrationBody.client_id!,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    decision: 'approve',
    qnotes_token: qnotesToken,
  });
  const authorization = await fetch(`${mcpUrl}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: authorizationForm,
  });
  expect(authorization.status).toBe(302);
  const authorizationLocation = authorization.headers.get('location');
  expect(authorizationLocation).toBeTruthy();
  const code = new URL(authorizationLocation!).searchParams.get('code');
  expect(code).toEqual(expect.any(String));

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: registrationBody.client_id!,
    code: code!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const token = await fetch(`${mcpUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm,
  });
  expect(token.status).toBe(200);
  expect((await token.json()).access_token).toEqual(expect.any(String));

  const replay = await fetch(`${mcpUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm,
  });
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
});

test('OAuth authorization-code consumption is single-use under concurrent redemption', async () => {
  const env = await localEnv();
  const client = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const codeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 90_000).toISOString();
  const consume = () => client.rpc('qnotes_consume_oauth_authorization_code', { p_code_id: codeId, p_expires_at: expiresAt });
  const results = await Promise.all([consume(), consume()]);

  for (const result of results) expect(result.error).toBeNull();
  expect(results.map((result) => result.data).sort()).toEqual([false, true]);
});
