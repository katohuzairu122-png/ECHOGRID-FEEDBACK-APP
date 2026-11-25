import { describe, expect, it } from 'vitest';
import { computeContentDigest, newNetworkHandle, normalizeNetworkContent, NetworkContentError } from './network-post';

const base = { body: 'Hello community', contentLocale: 'en' };

describe('network content rules', () => {
  it('normalizes to NFC, trims, and keeps a normalized https link', () => {
    expect(normalizeNetworkContent({ ...base, body: '  Café  ', linkUrl: 'HTTPS://Example.COM/Path' })).toEqual({
      body: 'Café', linkUrl: 'https://example.com/Path', contentLocale: 'en',
    });
  });

  it.each([
    ['empty', { ...base, body: '  ' }, 'body_length'],
    ['over 2,000', { ...base, body: 'a'.repeat(2001) }, 'body_length'],
    ['markup', { ...base, body: 'a <b>b</b>' }, 'body_characters'],
    ['control character', { ...base, body: 'a\u0007b' }, 'body_characters'],
    ['mention', { ...base, body: 'hi @someone' }, 'body_mentions'],
    ['hashtag', { ...base, body: '#sale today' }, 'body_mentions'],
    ['email', { ...base, body: 'mail a.b@c.io' }, 'personal_data'],
    ['phone', { ...base, body: 'call +1 (555) 123-4567' }, 'personal_data'],
    ['locale', { ...base, contentLocale: 'de' }, 'locale'],
    ['http link', { ...base, linkUrl: 'http://x.test' }, 'link_invalid'],
    ['ftp link', { ...base, linkUrl: 'ftp://x.test' }, 'link_invalid'],
    ['credentials', { ...base, linkUrl: 'https://u:p@x.test' }, 'link_invalid'],
    ['not a url', { ...base, linkUrl: 'nope' }, 'link_invalid'],
    ['overlong link', { ...base, linkUrl: `https://x.test/${'a'.repeat(2100)}` }, 'link_invalid'],
  ])('rejects %s', (_label, input, rule) => {
    expect(() => normalizeNetworkContent(input)).toThrow(NetworkContentError);
    try { normalizeNetworkContent(input); } catch (e) { expect((e as NetworkContentError).code).toBe(rule); }
  });

  it('counts characters, not UTF-16 units: 2,000 emoji is allowed', () => {
    expect(() => normalizeNetworkContent({ ...base, body: '😀'.repeat(2000) })).not.toThrow();
  });

  it('treats an empty or blank link as no link', () => {
    expect(normalizeNetworkContent({ ...base, linkUrl: '   ' }).linkUrl).toBeNull();
    expect(normalizeNetworkContent({ ...base, linkUrl: null }).linkUrl).toBeNull();
  });
});

describe('content digest and handle', () => {
  const content = { body: 'abc', linkUrl: 'https://x.test/', contentLocale: 'en' as const };

  it('is a stable SHA-256 over body, link and locale', async () => {
    const digest = await computeContentDigest(content);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await computeContentDigest({ ...content }));
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc\nhttps://x.test/\nen')))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe(expected);
  });

  it('changes when any part changes', async () => {
    const digest = await computeContentDigest(content);
    expect(await computeContentDigest({ ...content, body: 'abd' })).not.toBe(digest);
    expect(await computeContentDigest({ ...content, linkUrl: null })).not.toBe(digest);
    expect(await computeContentDigest({ ...content, contentLocale: 'fr' })).not.toBe(digest);
  });

  it('issues 22-character opaque base64url handles that do not repeat', () => {
    const handles = new Set(Array.from({ length: 200 }, newNetworkHandle));
    expect(handles.size).toBe(200);
    for (const h of handles) expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

import { resolveDailyPostCap, NETWORK_BUSINESS_DAILY_POST_CAP } from './network-business-post.service';
describe('resolveDailyPostCap (BCOMM-03)', () => {
  it('uses the default unless given a whole number from 1 to 100', () => {
    expect(resolveDailyPostCap(undefined)).toBe(NETWORK_BUSINESS_DAILY_POST_CAP);
    for (const bad of ['', '0', '101', '-1', '5.5', 'abc', ' 7', 7, null]) expect(resolveDailyPostCap(bad), String(bad)).toBe(NETWORK_BUSINESS_DAILY_POST_CAP);
    expect(resolveDailyPostCap('1')).toBe(1);
    expect(resolveDailyPostCap('100')).toBe(100);
  });
});
