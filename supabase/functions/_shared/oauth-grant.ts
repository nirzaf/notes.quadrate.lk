import { isUUID } from '@qnotes/shared';

export interface OAuthAccessTokenPayload {
  type: 'access_token';
  grantId: string;
  clientId: string;
  resource: string;
  expiresAt: number;
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function oauthKey(): Promise<CryptoKey> {
  const pepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  if (!pepper) throw new Error('QNOTES_TOKEN_PEPPER is not configured.');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signOAuthValue(prefix: string, payload: Record<string, unknown>): Promise<string> {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await oauthKey(), new TextEncoder().encode(encodedPayload)));
  return `${prefix}.${encodedPayload}.${base64Url(signature)}`;
}

export async function verifyOAuthValue<T>(value: string, prefix: string): Promise<T | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  try {
    const signature = new Uint8Array(decodeBase64Url(parts[2])) as Uint8Array<ArrayBuffer>;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await oauthKey(),
      signature,
      new TextEncoder().encode(parts[1]),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as T;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function isOAuthAccessToken(value: string): boolean {
  return value.startsWith('qoa.');
}

export async function verifyOAuthAccessToken(value: string): Promise<OAuthAccessTokenPayload | null> {
  const payload = await verifyOAuthValue<OAuthAccessTokenPayload>(value, 'qoa');
  if (!payload || payload.type !== 'access_token' || !isUUID(payload.grantId)
    || typeof payload.clientId !== 'string' || payload.clientId.length < 1 || payload.clientId.length > 4096
    || typeof payload.resource !== 'string' || payload.resource.length < 1 || payload.resource.length > 2048
    || !Number.isSafeInteger(payload.expiresAt)) return null;
  return payload;
}
