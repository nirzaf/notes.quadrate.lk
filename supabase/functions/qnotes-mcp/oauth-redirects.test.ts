import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStaticRedirectUris, hostedMcpOAuthScopes, HOSTED_MCP_OAUTH_SCOPE, isAllowedGoogleRedirect } from './oauth-redirects.ts';

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

test('hosted OAuth maps the supported external scope to the configured MCP profile', () => {
  assert.deepEqual(hostedMcpOAuthScopes(HOSTED_MCP_OAUTH_SCOPE, 'read'), ['notes:read', 'search:read']);
  assert.deepEqual(hostedMcpOAuthScopes(HOSTED_MCP_OAUTH_SCOPE, 'share'), ['notes:read', 'search:read', 'shares:write']);
  assert.equal(hostedMcpOAuthScopes('notes:read search:read', 'read'), null);
  assert.equal(hostedMcpOAuthScopes(`${HOSTED_MCP_OAUTH_SCOPE} extra`, 'read'), null);
});
