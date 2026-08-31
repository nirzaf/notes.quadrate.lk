const TOKEN_PREFIX = 'qnt_';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generatePersonalToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${base64Url(bytes)}`;
}

export async function hashPersonalToken(token: string): Promise<string> {
  const pepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  if (!pepper) throw new Error('QNOTES_TOKEN_PEPPER is not configured.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isPersonalToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}
