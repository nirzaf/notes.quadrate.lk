import test from 'node:test';
import assert from 'node:assert/strict';
import { isOAuthAccessToken, signOAuthValue, verifyOAuthAccessToken } from './oauth-grant.ts';

test('OAuth access tokens contain only a signed grant reference', async () => {
  const previous = Deno.env.get('QNOTES_TOKEN_PEPPER');
  Deno.env.set('QNOTES_TOKEN_PEPPER', 'synthetic-oauth-pepper');
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const token = await signOAuthValue('qoa', {
      type: 'access_token',
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientId: 'qdc.synthetic-client',
      resource: 'http://127.0.0.1:54321/functions/v1/qnotes-mcp',
      expiresAt,
    });
    assert.equal(isOAuthAccessToken(token), true);
    assert.deepEqual(await verifyOAuthAccessToken(token), {
      type: 'access_token',
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientId: 'qdc.synthetic-client',
      resource: 'http://127.0.0.1:54321/functions/v1/qnotes-mcp',
      expiresAt,
    });
    const [prefix, payload, signature] = token.split('.');
    const tampered = `${prefix}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    assert.equal(await verifyOAuthAccessToken(tampered), null);
  } finally {
    if (previous === undefined) Deno.env.delete('QNOTES_TOKEN_PEPPER');
    else Deno.env.set('QNOTES_TOKEN_PEPPER', previous);
  }
});

test('legacy wrapped access-token payloads are rejected', async () => {
  const previous = Deno.env.get('QNOTES_TOKEN_PEPPER');
  Deno.env.set('QNOTES_TOKEN_PEPPER', 'synthetic-oauth-pepper');
  try {
    const legacy = await signOAuthValue('qoa', {
      type: 'access_token',
      clientId: 'qdc.synthetic-client',
      resource: 'http://127.0.0.1:54321/functions/v1/qnotes-mcp',
      encryptedToken: 'never-returned',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    assert.equal(await verifyOAuthAccessToken(legacy), null);
  } finally {
    if (previous === undefined) Deno.env.delete('QNOTES_TOKEN_PEPPER');
    else Deno.env.set('QNOTES_TOKEN_PEPPER', previous);
  }
});
