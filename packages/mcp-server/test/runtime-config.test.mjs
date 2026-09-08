import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultBaseUrl } from '../dist/runtime-config.js';

test('Vault requests derive their base URL from QNOTES_URL when QVAULT_URL is absent', () => {
  const qnotesUrl = 'https://notes.example.test/functions/v1/qnotes-api';
  assert.equal(resolveVaultBaseUrl(qnotesUrl, undefined), qnotesUrl);
});

test('a non-empty QVAULT_URL fails closed without exposing its value', () => {
  const qnotesUrl = 'https://notes.example.test/functions/v1/qnotes-api';
  const qvaultUrl = 'https://unintended.example.test/vault';

  assert.throws(() => resolveVaultBaseUrl(qnotesUrl, qvaultUrl), (error) => {
    assert.equal(error.message, 'QVAULT_URL is not supported. Vault requests must use QNOTES_URL.');
    assert.equal(error.message.includes(qvaultUrl), false);
    return true;
  });
});
