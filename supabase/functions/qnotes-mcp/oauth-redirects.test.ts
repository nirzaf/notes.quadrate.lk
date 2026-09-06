import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStaticRedirectUris, isAllowedGoogleRedirect } from './oauth-redirects.ts';

const exactRedirect = 'https://oauth-redirect.googleusercontent.com/r/notes-prod';

test('static OAuth redirects require exact configured HTTPS Google URIs', () => {
  assert.deepEqual(configuredStaticRedirectUris(exactRedirect), [exactRedirect]);
  assert.equal(isAllowedGoogleRedirect(exactRedirect), true);
  assert.equal(isAllowedGoogleRedirect('https://oauth-redirect.googleusercontent.com/r/another-client'), true);
  assert.equal(isAllowedGoogleRedirect('https://oauth-redirect-sandbox.googleusercontent.com/r/notes-prod'), true);
  assert.equal(isAllowedGoogleRedirect('http://oauth-redirect.googleusercontent.com/r/notes-prod'), false);
  assert.equal(isAllowedGoogleRedirect('https://oauth-redirect.googleusercontent.com/r/notes-prod#fragment'), false);
});

test('static OAuth redirects fail closed when no exact URI is configured', () => {
  assert.equal(configuredStaticRedirectUris(undefined), null);
  assert.equal(configuredStaticRedirectUris(''), null);
  assert.equal(configuredStaticRedirectUris('https://oauth-redirect.googleusercontent.com/r/notes-prod,https://example.com/callback'), null);
});

test('static URI configuration keeps exact path distinctions', () => {
  const configured = configuredStaticRedirectUris(exactRedirect);
  assert.ok(configured);
  assert.equal(configured.includes('https://oauth-redirect.googleusercontent.com/r/another-client'), false);
});
