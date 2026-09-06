import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNoteShareToken, hashNoteShareToken, isValidNoteShareToken, noteShareTokenPrefix } from './share-token.ts';
import { hashPersonalToken } from './token.ts';

test('generates exact-format, random share tokens and domain-separated hashes', async () => {
  const previousPepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  Deno.env.set('QNOTES_TOKEN_PEPPER', 'local-share-test-pepper');
  try {
    const first = generateNoteShareToken();
    const second = generateNoteShareToken();
    assert.match(first, /^qns_[A-Za-z0-9_-]{43}$/);
    assert.match(second, /^qns_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    assert.equal(first.length, 47);
    assert.equal(noteShareTokenPrefix(first), first.slice(0, 12));
    assert.equal(await hashNoteShareToken(first), await hashNoteShareToken(first));
    assert.notEqual(await hashNoteShareToken(first), first);
    assert.notEqual(await hashNoteShareToken(first), await hashPersonalToken(first));
    assert.equal(isValidNoteShareToken(first), true);
    assert.equal(isValidNoteShareToken(`${first}x`), false);
    assert.equal(isValidNoteShareToken(first.replace(/^qns_/, 'qnt_')), false);
  } finally {
    if (typeof previousPepper === 'string') Deno.env.set('QNOTES_TOKEN_PEPPER', previousPepper);
    else Deno.env.delete('QNOTES_TOKEN_PEPPER');
  }
});
