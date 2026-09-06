import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function headerBlock(source, path) {
  const start = source.indexOf(`${path}\n`);
  assert.notEqual(start, -1, `${path} header block is missing`);
  const next = source.indexOf('\n/', start + path.length + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('Cloudflare headers enforce global and public-share CSP framing boundaries', async () => {
  const headers = await readFile('apps/web/public/_headers', 'utf8');
  const global = headerBlock(headers, '/*');
  const share = headerBlock(headers, '/share');

  assert.match(global, /Content-Security-Policy:[^\n]*frame-ancestors 'self' https:\/\/gemini\.google\.com https:\/\/accounts\.google\.com https:\/\/myaccount\.google\.com/);
  assert.match(share, /Content-Security-Policy:[^\n]*frame-ancestors 'none'/);
  assert.match(share, /Content-Security-Policy:[^\n]*frame-src 'none'/);
  assert.match(share, /Content-Security-Policy:[^\n]*form-action 'none'/);
  assert.match(share, /Cache-Control: no-store/);
  assert.match(share, /Referrer-Policy: no-referrer/);
  assert.match(share, /X-Robots-Tag: noindex, nofollow, noarchive, nosnippet/);
});

test('HTML meta CSP leaves framing enforcement to HTTP headers', async () => {
  const html = await readFile('apps/web/index.html', 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta);
  assert.equal(meta[1].includes('frame-ancestors'), false);
});
