import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVaultAgentToken, hashVaultAgentToken, hashVaultMutation, isVaultAgentToken } from './vault-token.ts';

test('qvt credentials use the exact 256-bit format and domain-separated HMAC', async () => {
  Deno.env.set('QNOTES_VAULT_TOKEN_PEPPER', 'local-only-vault-pepper');
  const first = generateVaultAgentToken();
  const second = generateVaultAgentToken();
  assert.match(first, /^qvt_[A-Za-z0-9_-]{43}$/);
  assert.equal(isVaultAgentToken(first), true);
  assert.notEqual(first, second);
  assert.notEqual(await hashVaultAgentToken(first), first);
  assert.notEqual(await hashVaultAgentToken(first), await hashVaultMutation({ token: first }));
  assert.equal(await hashVaultAgentToken(first), await hashVaultAgentToken(first));
});
