const NOTE_SHARE_TOKEN_PREFIX = 'qns_';
const NOTE_SHARE_TOKEN_BYTES = 32;
const NOTE_SHARE_TOKEN_PATTERN = /^qns_[A-Za-z0-9_-]{43}$/;
const NOTE_SHARE_HASH_DOMAIN = 'qnotes-note-share-v1\u0000';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateNoteShareToken(): string {
  const bytes = new Uint8Array(NOTE_SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${NOTE_SHARE_TOKEN_PREFIX}${base64Url(bytes)}`;
}

export async function hashNoteShareToken(token: string): Promise<string> {
  const pepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  if (!pepper) throw new Error('QNOTES_TOKEN_PEPPER is not configured.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${NOTE_SHARE_HASH_DOMAIN}${token}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidNoteShareToken(value: string): boolean {
  return NOTE_SHARE_TOKEN_PATTERN.test(value);
}

export function noteShareTokenPrefix(token: string): string {
  return token.slice(0, 12);
}
