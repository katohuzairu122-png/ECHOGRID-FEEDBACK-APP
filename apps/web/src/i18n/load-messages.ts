import type { Locale } from '@echo-grid-feedback/shared-types';

/**
 * Namespace files to load for every request (i18n & Multi-Currency Block 2).
 * One JSON file per feature module under messages/<locale>/, matching this
 * app's existing feature-based folder convention -- keeps each module's
 * translations in one small file instead of a single ever-growing
 * monolith. Blocks 4-7 each add their own module's namespace here as that
 * module's UI gets translated; 'common' is the only one Block 2 seeds with
 * real content.
 */
const NAMESPACES = [
  'common',
  'dashboard',
  'auth',
  'branches',
  'feedback',
  'loyalty',
  'analytics',
  'notifications',
  'platform',
] as const;

type Messages = Record<string, unknown>;

/**
 * Loads and merges every namespace file for a locale into the single
 * nested object next-intl expects (`messages.<namespace>.<key>`, read via
 * `useTranslations('<namespace>')`). Dynamic import with a template literal
 * over a small, closed set of locale/namespace values is next-intl's own
 * documented pattern for split message files -- the bundler resolves it as
 * a context module (every matching messages/<locale>/<namespace>.json file
 * gets bundled), not an arbitrary runtime path.
 */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const entries = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const mod = (await import(`../../messages/${locale}/${namespace}.json`)) as {
        default: Messages;
      };
      return [namespace, mod.default] as const;
    }),
  );

  return Object.fromEntries(entries);
}
