export type PublicShareClassification = 'publishable' | 'sensitive';

const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+\S+/i,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer[_ -]?token|client[_ -]?secret|service[_ -]?(?:key|token|password|secret)|private[_ -]?key|encryption[_ -]?key|database[_ -]?url|connection[_ -]?string)\s*[:=]\s*['"]?[^\s'"`]+/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|https?):\/\/[^\s'"`]+:[^\s'"`]+@/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:ghp|gho|ghs|ghr|glpat|github_pat)[_-][A-Za-z0-9_-]{12,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i,
  /\bqnt_[A-Za-z0-9_-]{20,}\b/,
  /\bqns_[A-Za-z0-9_-]{20,}\b/,
  /(?:^|[^A-Za-z0-9_-])qvt_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export function classifyPublicShareContent(title: string, contentMarkdown: string): PublicShareClassification {
  const searchableContent = `${title}\n${contentMarkdown}`;
  return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(searchableContent)) ? 'sensitive' : 'publishable';
}

export async function hashPublicShareContent(title: string, contentMarkdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${title}\n${contentMarkdown}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
