const GOOGLE_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
]);

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
