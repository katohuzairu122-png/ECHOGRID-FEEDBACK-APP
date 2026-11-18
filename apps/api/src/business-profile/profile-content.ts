/**
 * BDPN-01B part 1: business profile content validation (development only, pure functions, no database).
 * Implements `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` section 2 (field rules) and the content half of
 * section 3 (submission completeness). The database keeps only lengths and enumerations (BDPN-01A); every
 * content rule lives here so it can be tuned without a schema change.
 *
 * Rules that depend on owner decision D-16 (the content policy and the moderation reason codes) are NOT defined here:
 * this module validates shape, characters and contact-data patterns only, and never judges whether content is allowed.
 * Failures return a field-level list with no echo of the rejected text (design section 5.4).
 *
 * Workers-safe: no Node-only APIs. The supported locales are repeated here on purpose (the database schema module
 * lands in a separate block); a later block unifies them behind one constant.
 */
export const PROFILE_CONTENT_LOCALES = ['en', 'es', 'fr', 'ar'] as const;
export type ProfileContentLocale = (typeof PROFILE_CONTENT_LOCALES)[number];
export const PROFILE_LOCATION_KINDS = ['place', 'service_area'] as const;
export type ProfileLocationKind = (typeof PROFILE_LOCATION_KINDS)[number];

export const PROFILE_LIMITS = {
  displayName: { min: 2, max: 80 },
  summary: { min: 1, max: 160 },
  description: { min: 1, max: 1000, maxLines: 20 },
  websiteMaxChars: 2000,
  label: { min: 1, max: 120 },
  city: { min: 1, max: 80 },
  region: { min: 1, max: 80 },
  streetAddress: { min: 1, max: 160 },
  locations: { min: 1, max: 10 },
  translations: { max: 4 },
} as const;

export type ProfileFieldError = { field: string; rule: string };

export type ProfileTranslationInput = { locale: string; displayName: string; summary?: string | null; description?: string | null };
export type ProfileLocationInput = {
  kind: string;
  label: string;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  streetAddress?: string | null;
};
export type ProfileContentInput = {
  websiteUrl?: string | null;
  translations: ProfileTranslationInput[];
  locations: ProfileLocationInput[];
  /** The business ticked the "show my street address" opt-in. Without it a street address is refused. */
  streetAddressOptIn?: boolean;
};

export type NormalizedProfileTranslation = {
  locale: ProfileContentLocale;
  displayName: string;
  summary: string | null;
  description: string | null;
};
export type NormalizedProfileLocation = {
  position: number;
  kind: ProfileLocationKind;
  label: string;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  streetAddress: string | null;
};
export type NormalizedProfileContent = {
  websiteUrl: string | null;
  translations: NormalizedProfileTranslation[];
  locations: NormalizedProfileLocation[];
};

export type ProfileValidationResult =
  | { ok: true; content: NormalizedProfileContent }
  | { ok: false; errors: ProfileFieldError[] };

export type ProfileValidationOptions = {
  /** The business default locale. Needed when `requireComplete` is set. */
  defaultLocale?: string;
  /** Submission completeness (D-04): default-locale name, summary and description, and at least one location. */
  requireComplete?: boolean;
};

/** ISO 3166-1 alpha-2 (249 officially assigned codes). */
export const ISO_3166_1_ALPHA_2: ReadonlySet<string> = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
    'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '),
);

const LOCALES: readonly string[] = PROFILE_CONTENT_LOCALES;
const KINDS: readonly string[] = PROFILE_LOCATION_KINDS;

// Rejected characters (design section 2). Format characters (Cf) are refused except ZWNJ and ZWJ, which Arabic and
// other scripts need; that also covers the bidirectional override and isolate characters (U+202A to U+202E and
// U+2066 to U+2069), which are all Cf. Control characters (Cc), unassigned (Cn), private use (Co) and lone
// surrogates (Cs) are refused. A description may keep line breaks.
const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
const UNASSIGNED_OR_PRIVATE = /[\p{Cn}\p{Co}\p{Cs}]/u;
// A contact pattern in free text belongs in its own field, never in a name, summary, description or location text.
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_PATTERN = /\p{Nd}(?:[ .-]?\p{Nd}){6,}/u;

const length = (text: string) => [...text].length;

type TextRule = { min: number; max: number };
type TextOptions = { multiline?: boolean; maxLines?: number };

/**
 * NFC, trim, then check characters and contact patterns and length. Returns the cleaned text or an error rule; the
 * rejected text itself is never returned.
 */
function cleanText(raw: unknown, rule: TextRule, options: TextOptions = {}): { value: string } | { rule: string } {
  if (typeof raw !== 'string') return { rule: 'invalid' };
  let text = raw.normalize('NFC').trim();
  if (options.multiline) text = text.replace(/\r\n?/g, '\n');
  for (const char of text) {
    if (options.multiline && char === '\n') continue;
    if (CONTROL.test(char)) return { rule: 'characters' };
    if (char !== '‌' && char !== '‍' && FORMAT.test(char)) return { rule: 'characters' };
    if (UNASSIGNED_OR_PRIVATE.test(char)) return { rule: 'characters' };
  }
  if (URL_PATTERN.test(text) || EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text)) return { rule: 'contact_pattern' };
  const size = length(text);
  if (size < rule.min || size > rule.max) return { rule: 'length' };
  if (options.maxLines !== undefined && text.split('\n').length > options.maxLines) return { rule: 'too_many_lines' };
  return { value: text };
}

const TRACKING_PARAMETER = /^(?:utm_.*|fbclid|gclid)$/i;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * https only; a host with a dot; no userinfo; no non-default port; no IP address or localhost host; at most 2000
 * characters; the fragment and known tracking parameters are removed; an internationalized host is stored as ASCII
 * (the URL parser performs the punycode conversion). The normalized href is what is stored and shown.
 */
export function normalizeProfileWebsite(raw: unknown): { value: string } | { rule: string } {
  if (typeof raw !== 'string') return { rule: 'invalid' };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > PROFILE_LIMITS.websiteMaxChars) return { rule: 'length' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { rule: 'invalid_url' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return { rule: 'invalid_url' };
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || IPV4_HOST.test(host) || host.startsWith('[') || host.includes(':')) {
    return { rule: 'invalid_host' };
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  const href = url.href;
  if (href.length > PROFILE_LIMITS.websiteMaxChars || /[\s<>"]/.test(href)) return { rule: 'length' };
  return { value: href };
}

/**
 * Validates and normalizes profile content. Never throws for bad input; returns every field error found. With
 * `requireComplete` it also enforces the content half of the submission rules (D-04). Category, business status and
 * "no other submitted revision" are database facts and belong to the transition service, not this function.
 */
export function validateProfileContent(input: ProfileContentInput, options: ProfileValidationOptions = {}): ProfileValidationResult {
  const errors: ProfileFieldError[] = [];
  const fail = (field: string, rule: string) => errors.push({ field, rule });

  let websiteUrl: string | null = null;
  if (input.websiteUrl !== undefined && input.websiteUrl !== null && String(input.websiteUrl).trim() !== '') {
    const website = normalizeProfileWebsite(input.websiteUrl);
    if ('rule' in website) fail('website_url', website.rule);
    else websiteUrl = website.value;
  }

  const translations: NormalizedProfileTranslation[] = [];
  const seenLocales = new Set<string>();
  if (!Array.isArray(input.translations)) {
    fail('translations', 'invalid');
  } else {
    if (input.translations.length > PROFILE_LIMITS.translations.max) fail('translations', 'too_many');
    input.translations.forEach((entry, index) => {
      const base = `translations[${index}]`;
      if (typeof entry !== 'object' || entry === null) return fail(base, 'invalid');
      if (!LOCALES.includes(entry.locale)) fail(`${base}.locale`, 'unsupported_locale');
      else if (seenLocales.has(entry.locale)) fail(`${base}.locale`, 'duplicate');
      else seenLocales.add(entry.locale);
      const name = cleanText(entry.displayName, PROFILE_LIMITS.displayName);
      if ('rule' in name) fail(`${base}.display_name`, name.rule);
      let summary: string | null = null;
      if (entry.summary !== undefined && entry.summary !== null && String(entry.summary).trim() !== '') {
        const cleaned = cleanText(entry.summary, PROFILE_LIMITS.summary);
        if ('rule' in cleaned) fail(`${base}.summary`, cleaned.rule);
        else summary = cleaned.value;
      }
      let description: string | null = null;
      if (entry.description !== undefined && entry.description !== null && String(entry.description).trim() !== '') {
        const cleaned = cleanText(entry.description, PROFILE_LIMITS.description, { multiline: true, maxLines: PROFILE_LIMITS.description.maxLines });
        if ('rule' in cleaned) fail(`${base}.description`, cleaned.rule);
        else description = cleaned.value;
      }
      if ('value' in name && LOCALES.includes(entry.locale)) {
        translations.push({ locale: entry.locale as ProfileContentLocale, displayName: name.value, summary, description });
      }
    });
  }

  const locations: NormalizedProfileLocation[] = [];
  if (!Array.isArray(input.locations)) {
    fail('locations', 'invalid');
  } else {
    if (input.locations.length > PROFILE_LIMITS.locations.max) fail('locations', 'too_many');
    input.locations.forEach((entry, index) => {
      const base = `locations[${index}]`;
      if (typeof entry !== 'object' || entry === null) return fail(base, 'invalid');
      const kindOk = KINDS.includes(entry.kind);
      if (!kindOk) fail(`${base}.kind`, 'invalid');
      const label = cleanText(entry.label, PROFILE_LIMITS.label);
      if ('rule' in label) fail(`${base}.label`, label.rule);

      const optionalText = (field: 'city' | 'region' | 'streetAddress', name: string, rule: TextRule): string | null => {
        const raw = entry[field];
        if (raw === undefined || raw === null || String(raw).trim() === '') return null;
        const cleaned = cleanText(raw, rule);
        if ('rule' in cleaned) {
          fail(`${base}.${name}`, cleaned.rule);
          return null;
        }
        return cleaned.value;
      };
      const city = optionalText('city', 'city', PROFILE_LIMITS.city);
      const region = optionalText('region', 'region', PROFILE_LIMITS.region);
      const street = optionalText('streetAddress', 'street_address', PROFILE_LIMITS.streetAddress);

      let countryCode: string | null = null;
      if (entry.countryCode !== undefined && entry.countryCode !== null && entry.countryCode !== '') {
        if (typeof entry.countryCode === 'string' && /^[A-Z]{2}$/.test(entry.countryCode) && ISO_3166_1_ALPHA_2.has(entry.countryCode)) {
          countryCode = entry.countryCode;
        } else {
          fail(`${base}.country_code`, 'invalid_country');
        }
      }
      if (entry.kind === 'place') {
        if (city === null && !errors.some((e) => e.field === `${base}.city`)) fail(`${base}.city`, 'required');
        if (countryCode === null && !errors.some((e) => e.field === `${base}.country_code`)) fail(`${base}.country_code`, 'required');
      }
      if (street !== null) {
        if (entry.kind !== 'place') fail(`${base}.street_address`, 'not_allowed');
        else if (input.streetAddressOptIn !== true) fail(`${base}.street_address`, 'opt_in_required');
      }
      if (kindOk && 'value' in label) {
        locations.push({
          position: index,
          kind: entry.kind as ProfileLocationKind,
          label: label.value,
          countryCode,
          city,
          region,
          streetAddress: street,
        });
      }
    });
  }

  if (options.requireComplete) {
    if (locations.length < PROFILE_LIMITS.locations.min && !errors.some((e) => e.field === 'locations')) fail('locations', 'required');
    const defaultLocale = options.defaultLocale;
    const index = Array.isArray(input.translations) ? input.translations.findIndex((t) => t?.locale === defaultLocale) : -1;
    if (defaultLocale === undefined || !LOCALES.includes(defaultLocale) || index < 0) {
      fail('translations.default_locale', 'required');
    } else {
      const present = translations.find((t) => t.locale === defaultLocale);
      const base = `translations[${index}]`;
      if (present !== undefined) {
        if (present.summary === null && !errors.some((e) => e.field === `${base}.summary`)) fail(`${base}.summary`, 'required');
        if (present.description === null && !errors.some((e) => e.field === `${base}.description`)) fail(`${base}.description`, 'required');
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, content: { websiteUrl, translations, locations } };
}
