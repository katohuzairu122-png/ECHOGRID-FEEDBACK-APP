import { describe, expect, it } from 'vitest';
import {
  ISO_3166_1_ALPHA_2, normalizeProfileWebsite, validateProfileContent,
  type ProfileContentInput,
} from './profile-content';
import { canonicalProfileJson, computeProfileDigest } from './profile-digest';
import { normalizeDisplayNameForSearch } from './profile-search';
import { isProfileHandle, newProfileHandle } from './profile-handle';

const place = { kind: 'place', label: 'Salmiya', countryCode: 'KW', city: 'Kuwait City' } as const;
const base = (over: Partial<ProfileContentInput> = {}): ProfileContentInput => ({
  websiteUrl: null,
  translations: [{ locale: 'en', displayName: 'Buddy Cafe', summary: 'Coffee shop', description: 'Specialty coffee.' }],
  locations: [{ ...place }],
  ...over,
});
const errors = (input: ProfileContentInput, options = {}) => {
  const result = validateProfileContent(input, options);
  return result.ok ? [] : result.errors;
};

describe('profile content validation (BDPN-01B section 2)', () => {
  it('accepts valid content and normalizes it (NFC, trim, positions)', () => {
    const result = validateProfileContent(base({
      websiteUrl: ' https://Example.com/menu#top ',
      translations: [{ locale: 'en', displayName: '  Café Aroma  ', summary: ' Coffee ', description: 'Line one\r\nLine two' }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.translations[0]).toEqual({ locale: 'en', displayName: 'Café Aroma', summary: 'Coffee', description: 'Line one\nLine two' });
    expect(result.content.websiteUrl).toBe('https://example.com/menu');
    expect(result.content.locations[0]).toMatchObject({ position: 0, kind: 'place', countryCode: 'KW', region: null, streetAddress: null });
  });

  it('enforces text lengths by code point, not bytes', () => {
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'A' }] }))).toContainEqual({ field: 'translations[0].display_name', rule: 'length' });
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'x'.repeat(81) }] }))).toContainEqual({ field: 'translations[0].display_name', rule: 'length' });
    expect(errors(base({ translations: [{ locale: 'en', displayName: '\u{1F600}'.repeat(80) }] }))).toEqual([]);
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'Ok name', summary: 'x'.repeat(161) }] }))).toContainEqual({ field: 'translations[0].summary', rule: 'length' });
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'Ok name', description: 'x'.repeat(1001) }] }))).toContainEqual({ field: 'translations[0].description', rule: 'length' });
    const twentyOne = Array.from({ length: 21 }, (_, i) => `L${i}`).join('\n');
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'Ok name', description: twentyOne }] }))).toContainEqual({ field: 'translations[0].description', rule: 'too_many_lines' });
    const twenty = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'Ok name', description: twenty }] }))).toEqual([]);
  });

  it('rejects control, format, bidirectional, private-use and lone-surrogate characters but allows ZWNJ and ZWJ', () => {
    const name = (s: string) => errors(base({ translations: [{ locale: 'en', displayName: s }] }));
    expect(name('Bad\u0007name')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Bad\nname')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Bad‮name')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Bad⁦name')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Bad​name')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Badname')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Bad\uD800name')).toContainEqual({ field: 'translations[0].display_name', rule: 'characters' });
    expect(name('Fa‌rsi‍name')).toEqual([]);
  });

  it('rejects URLs, emails and phone-like digit runs in text, but not digits in prose', () => {
    const summary = (s: string) => errors(base({ translations: [{ locale: 'en', displayName: 'Ok name', summary: s }] }));
    for (const bad of ['see https://x.example', 'visit www.x.example', 'mail me@x.example', 'call 555 123 4567', 'call 555.123.4567', 'call 555-123-4567', 'call 0555123456']) {
      expect(summary(bad), bad).toContainEqual({ field: 'translations[0].summary', rule: 'contact_pattern' });
    }
    expect(summary('call ٥٥٥١٢٣٤')).toContainEqual({ field: 'translations[0].summary', rule: 'contact_pattern' });
    expect(summary('Open since 1998, 12 branches')).toEqual([]);
    expect(errors(base({ locations: [{ ...place, label: 'Call 555 123 4567' }] }))).toContainEqual({ field: 'locations[0].label', rule: 'contact_pattern' });
  });

  it('does not echo the rejected text in any error', () => {
    const secret = 'secret@leak.example';
    expect(JSON.stringify(errors(base({ translations: [{ locale: 'en', displayName: secret }] })))).not.toContain('leak');
  });

  it('validates translations: closed locale set, no duplicates, at most four', () => {
    expect(errors(base({ translations: [{ locale: 'de', displayName: 'Name' }] }))).toContainEqual({ field: 'translations[0].locale', rule: 'unsupported_locale' });
    expect(errors(base({ translations: [{ locale: 'en', displayName: 'Name' }, { locale: 'en', displayName: 'Other' }] }))).toContainEqual({ field: 'translations[1].locale', rule: 'duplicate' });
    const five = ['en', 'es', 'fr', 'ar', 'en'].map((locale) => ({ locale, displayName: 'Name' }));
    expect(errors(base({ translations: five }))).toContainEqual({ field: 'translations', rule: 'too_many' });
    expect(errors(base({ translations: ['en', 'es', 'fr', 'ar'].map((locale) => ({ locale, displayName: 'Name' })) }))).toEqual([]);
  });

  it('validates locations: kinds, country list, place fields, street opt-in and limits', () => {
    expect(errors(base({ locations: [{ kind: 'branch', label: 'X' }] }))).toContainEqual({ field: 'locations[0].kind', rule: 'invalid' });
    expect(errors(base({ locations: [{ kind: 'place', label: 'X', countryCode: 'KW' }] }))).toContainEqual({ field: 'locations[0].city', rule: 'required' });
    expect(errors(base({ locations: [{ kind: 'place', label: 'X', city: 'Kuwait City' }] }))).toContainEqual({ field: 'locations[0].country_code', rule: 'required' });
    expect(errors(base({ locations: [{ ...place, countryCode: 'kw' }] }))).toContainEqual({ field: 'locations[0].country_code', rule: 'invalid_country' });
    expect(errors(base({ locations: [{ ...place, countryCode: 'XX' }] }))).toContainEqual({ field: 'locations[0].country_code', rule: 'invalid_country' });
    expect(errors(base({ locations: [{ ...place, streetAddress: '1 Gulf Road' }] }))).toContainEqual({ field: 'locations[0].street_address', rule: 'opt_in_required' });
    expect(errors(base({ streetAddressOptIn: true, locations: [{ ...place, streetAddress: '1 Gulf Road' }] }))).toEqual([]);
    expect(errors(base({ streetAddressOptIn: true, locations: [{ kind: 'service_area', label: 'Greater Kuwait', streetAddress: '1 Gulf Road' }] }))).toContainEqual({ field: 'locations[0].street_address', rule: 'not_allowed' });
    expect(errors(base({ locations: [{ kind: 'service_area', label: 'Greater Kuwait' }] }))).toEqual([]);
    const eleven = Array.from({ length: 11 }, () => ({ ...place }));
    expect(errors(base({ locations: eleven }))).toContainEqual({ field: 'locations', rule: 'too_many' });
    const ten = Array.from({ length: 10 }, () => ({ ...place }));
    const result = validateProfileContent(base({ locations: ten }));
    expect(result.ok && result.content.locations.map((l) => l.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('has the 249 officially assigned ISO 3166-1 alpha-2 codes', () => {
    expect(ISO_3166_1_ALPHA_2.size).toBe(249);
    for (const code of ['US', 'GB', 'KW', 'FR', 'ES', 'SA', 'AE', 'EG']) expect(ISO_3166_1_ALPHA_2.has(code)).toBe(true);
    for (const code of ['UK', 'XX', 'EU', 'AA']) expect(ISO_3166_1_ALPHA_2.has(code)).toBe(false);
  });

  describe('submission completeness (D-04, content half)', () => {
    it('needs the default-locale summary and description and at least one location', () => {
      const opts = { requireComplete: true, defaultLocale: 'fr' };
      expect(errors(base(), opts)).toContainEqual({ field: 'translations.default_locale', rule: 'required' });
      const noText = base({ translations: [{ locale: 'fr', displayName: 'Cafe Aroma' }] });
      expect(errors(noText, opts)).toEqual(expect.arrayContaining([
        { field: 'translations[0].summary', rule: 'required' },
        { field: 'translations[0].description', rule: 'required' },
      ]));
      expect(errors({ ...noText, locations: [] }, opts)).toContainEqual({ field: 'locations', rule: 'required' });
      const complete = base({ translations: [{ locale: 'fr', displayName: 'Cafe Aroma', summary: 'Cafe', description: 'Du cafe frais.' }] });
      expect(errors(complete, opts)).toEqual([]);
    });

    it('lets a draft be incomplete', () => {
      expect(errors({ translations: [{ locale: 'en', displayName: 'Draft name' }], locations: [] })).toEqual([]);
    });
  });
});

describe('website normalization (BDPN-01B section 2)', () => {
  const ok = (s: string) => {
    const r = normalizeProfileWebsite(s);
    return 'value' in r ? r.value : `ERR:${r.rule}`;
  };
  it('keeps https, drops fragment and tracking parameters, lowercases the host, stores punycode', () => {
    expect(ok('https://Example.COM')).toBe('https://example.com/');
    expect(ok('https://example.com/a?b=1&utm_source=x&fbclid=y&gclid=z&UTM_medium=m#frag')).toBe('https://example.com/a?b=1');
    expect(ok('https://bücher.example/')).toBe('https://xn--bcher-kva.example/');
  });
  it('refuses http, userinfo, ports, IP and local hosts, dotless hosts, junk and over-long values', () => {
    expect(ok('http://example.com')).toBe('ERR:invalid_url');
    expect(ok('https://user:pw@example.com')).toBe('ERR:invalid_url');
    expect(ok('https://example.com:8443')).toBe('ERR:invalid_url');
    expect(ok('https://127.0.0.1/')).toBe('ERR:invalid_host');
    expect(ok('https://[::1]/')).toBe('ERR:invalid_host');
    expect(ok('https://localhost/')).toBe('ERR:invalid_host');
    expect(ok('https://intranet/')).toBe('ERR:invalid_host');
    expect(ok('javascript:alert(1)')).toBe('ERR:invalid_url');
    expect(ok('not a url')).toBe('ERR:invalid_url');
    expect(ok(`https://example.com/${'a'.repeat(2000)}`)).toBe('ERR:length');
  });
});

describe('content digest (BDPN-01B section 4.1)', () => {
  const vector = (cafe: string): ProfileContentInput => ({
    websiteUrl: 'https://example.com',
    translations: [
      { locale: 'en', displayName: `Buddy ${cafe}`, summary: 'Coffee shop in Salmiya', description: 'Specialty coffee and pastries.' },
      { locale: 'ar', displayName: 'بدي كافيه' },
    ],
    locations: [{ kind: 'place', label: 'Salmiya', countryCode: 'KW', city: 'Kuwait City' }],
  });
  const content = (input: ProfileContentInput) => {
    const r = validateProfileContent(input);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.content;
  };

  // Test vector 1 from the design document: canonical bytes and SHA-256 are reproduced exactly.
  it('reproduces test vector 1 (canonical bytes and SHA-256)', async () => {
    const canonical =
      '{"locations":[{"city":"Kuwait City","country_code":"KW","kind":"place","label":"Salmiya","position":0,"region":null,"street_address":null}],' +
      '"translations":[{"description":null,"display_name":"بدي كافيه","locale":"ar","summary":null},' +
      '{"description":"Specialty coffee and pastries.","display_name":"Buddy Café","locale":"en","summary":"Coffee shop in Salmiya"}],"website_url":"https://example.com/"}';
    const c = content(vector('Café'));
    expect(canonicalProfileJson(c)).toBe(canonical);
    expect(await computeProfileDigest(c)).toBe('61ae1a5b3e0d29308bb0f50d6abcd70edad98836cbee7765b0c6034568de6d33');
  });

  // Test vector 2: the decomposed form of the same text hashes identically (NFC before hashing).
  it('reproduces test vector 2: decomposed and composed text give the same digest', async () => {
    const composed = await computeProfileDigest(content(vector('Café')));
    const decomposed = await computeProfileDigest(content(vector('Café')));
    expect(decomposed).toBe(composed);
  });

  it('is independent of input order and changes when any approved field changes', async () => {
    const a = content(vector('Café'));
    const reordered = { ...a, translations: [...a.translations].reverse() };
    expect(await computeProfileDigest(reordered)).toBe(await computeProfileDigest(a));
    const changedWebsite = await computeProfileDigest({ ...a, websiteUrl: 'https://example.org/' });
    const changedLocation = await computeProfileDigest({ ...a, locations: [{ ...a.locations[0]!, city: 'Hawalli' }] });
    const digests = new Set([await computeProfileDigest(a), changedWebsite, changedLocation]);
    expect(digests.size).toBe(3);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes absent optional values as null, never as undefined or empty strings', () => {
    const c = content({ translations: [{ locale: 'en', displayName: 'Only name' }], locations: [{ kind: 'service_area', label: 'Wide area' }] });
    const json = canonicalProfileJson(c);
    expect(json).toContain('"website_url":null');
    expect(json).toContain('"summary":null');
    expect(json).toContain('"street_address":null');
    expect(json).not.toContain('undefined');
  });
});

describe('search normalization (BDPN-01B section 4.2)', () => {
  it('removes accents and case, collapses whitespace', () => {
    expect(normalizeDisplayNameForSearch(' Buddy Café ')).toBe('buddy cafe');
    expect(normalizeDisplayNameForSearch('Café')).toBe(normalizeDisplayNameForSearch('cafe'));
    expect(normalizeDisplayNameForSearch('Crème   Brûlée')).toBe('creme brulee');
    expect(normalizeDisplayNameForSearch('El Niño')).toBe('el nino');
    expect(normalizeDisplayNameForSearch('Straße')).toBe('strasse');
    expect(normalizeDisplayNameForSearch('ﬁsh')).toBe('fish');
  });
  it('removes Arabic short-vowel marks and leaves Arabic base letters alone', () => {
    expect(normalizeDisplayNameForSearch('بَدِّي كَافِيه')).toBe('بدي كافيه');
    // hamza-on-alef (composed) is a base letter and must survive; the decomposed form composes to the same value
    expect(normalizeDisplayNameForSearch('أحمد')).toBe('أحمد');
    expect(normalizeDisplayNameForSearch('أحمد')).toBe('أحمد');
  });
  it('is stable: applying it twice gives the same value', () => {
    for (const s of [' Buddy Café ', 'بَدِي', 'Straße', 'Niño  Crème']) {
      const once = normalizeDisplayNameForSearch(s);
      expect(normalizeDisplayNameForSearch(once)).toBe(once);
    }
  });
});

describe('profile handle (D-10)', () => {
  it('is 22 base64url characters, random, and a valid handle', () => {
    const handles = new Set(Array.from({ length: 200 }, () => newProfileHandle()));
    expect(handles.size).toBe(200);
    for (const h of handles) {
      expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isProfileHandle(h)).toBe(true);
    }
    expect(isProfileHandle('short')).toBe(false);
    expect(isProfileHandle('7a557c2a-4709-41f1-9f75-153a9cf7a70a')).toBe(false);
    expect(isProfileHandle(null)).toBe(false);
  });
});
