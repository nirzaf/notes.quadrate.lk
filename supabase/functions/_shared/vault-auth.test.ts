import test from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_STEP_UP_MAX_AGE_SECONDS, verifyVaultJwtClaims } from './vault-auth.ts';

const issuer = 'https://qnotes.example/auth/v1';
const now = 1_800_000_000;
const baseClaims = {
  sub: '550e8400-e29b-41d4-a716-446655440000',
  session_id: '660e8400-e29b-41d4-a716-446655440000',
  aud: 'authenticated',
  iss: issuer,
  role: 'authenticated',
  exp: now + 60,
};

test('Vault accepts only issuer and audience validated claims before reading assurance', () => {
  assert.deepEqual(verifyVaultJwtClaims({ ...baseClaims, aal: 'aal2', amr: [{ method: 'totp', timestamp: now - 30 }] }, issuer, now), {
    userId: baseClaims.sub,
    sessionId: baseClaims.session_id,
    assuranceLevel: 'aal2',
    mfaVerifiedAt: now - 30,
  });
  assert.throws(() => verifyVaultJwtClaims({ ...baseClaims, iss: 'https://attacker.example/auth/v1', aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] }, issuer, now), /invalid/);
  assert.throws(() => verifyVaultJwtClaims({ ...baseClaims, aud: 'service_role', aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] }, issuer, now), /invalid/);
  assert.throws(() => verifyVaultJwtClaims({ ...baseClaims, exp: now, aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] }, issuer, now), /invalid/);
});

test('Vault does not treat refresh time or stale MFA as a current step-up', () => {
  const stale = verifyVaultJwtClaims({ ...baseClaims, aal: 'aal2', iat: now, amr: [{ method: 'totp', timestamp: now - VAULT_STEP_UP_MAX_AGE_SECONDS - 1 }] }, issuer, now);
  assert.equal(stale.assuranceLevel, 'aal2');
  assert.equal(stale.mfaVerifiedAt, null);
  const refreshedOnly = verifyVaultJwtClaims({ ...baseClaims, iat: now, aal: 'aal1' }, issuer, now);
  assert.equal(refreshedOnly.assuranceLevel, 'aal1');
  assert.equal(refreshedOnly.mfaVerifiedAt, null);
});
