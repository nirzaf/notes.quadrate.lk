const GOOGLE_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
]);

export const HOSTED_MCP_OAUTH_SCOPE = 'ACCESS_VIEW_MANAGE_MCP_CONTENT';
export type HostedMcpProfile = 'read' | 'share';
export type HostedMcpOAuthScope = 'notes:read' | 'search:read' | 'shares:write';

export function hostedMcpOAuthScopes(scope: string, profile: HostedMcpProfile): HostedMcpOAuthScope[] | null {
  if (scope.trim() !== HOSTED_MCP_OAUTH_SCOPE) return null;
  return profile === 'share'
    ? ['notes:read', 'search:read', 'shares:write']
    : ['notes:read', 'search:read'];
}

export function isAllowedGoogleRedirect(uri: string): boolean {
  try {
    const redirect = new URL(uri);
    return redirect.protocol === 'https:' && GOOGLE_REDIRECT_HOSTS.has(redirect.hostname) && !redirect.hash;
  } catch {
    return false;
  }
}

export function configuredStaticRedirectUris(value: string | undefined): string[] | null {
  const uris = (value ?? '').split(',').map((uri) => uri.trim()).filter(Boolean);
  if (uris.length === 0 || uris.length > 16 || uris.some((uri) => !isAllowedGoogleRedirect(uri))) return null;
  return [...new Set(uris)];
}
