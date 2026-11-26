import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * G10 Cloudflare / deployment-config readiness (READ-ONLY inspection of the repository; no Cloudflare resource is touched): every feature control is absent from every committed Worker config and
 * workflow, so a deployment can never activate Community, Badges, Shuffle or Drops by itself; staging and production are isolated (distinct worker names and Hyperdrive ids).
 */
const root = join(process.cwd(), '../..');
const CONTROLS = ['TENTASHIP_BADGES_ENABLED', 'TENTASHIP_SHUFFLE_ENABLED', 'TENTASHIP_DROPS_ENABLED', 'NETWORK_FEED_ENABLED', 'NETWORK_BUSINESS_PUBLISHING_ENABLED', 'NETWORK_BUSINESS_DISTRIBUTION_ENABLED',
  'COMMUNITY_MEMBERSHIP_JOIN_ENABLED', 'COMMUNITY_MEMBERSHIP_REJOIN_ENABLED', 'COMMUNITY_MEMBERSHIP_RESTORE_ENABLED', 'COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED'];
const configs = [join(root, 'apps/api/wrangler.toml'), join(root, 'apps/api/wrangler.workers-local.toml'), join(root, 'apps/web/wrangler.toml'), join(root, 'apps/mail-receiver/wrangler.toml'), join(root, 'apps/private-stripe-verifier/wrangler.toml')].filter(existsSync);
const workflows = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(root, '.github/workflows', f));

describe('G10 deployment configuration keeps every feature control off and environments isolated', () => {
  it('no control appears in any committed Worker config or workflow (they are set only by the Owner, outside the repository)', () => {
    for (const f of [...configs, ...workflows]) { const text = readFileSync(f, 'utf8'); for (const c of CONTROLS) expect(text.includes(c), `${c} in ${f}`).toBe(false); }
  });
  it('staging and production API Workers are isolated: distinct names and distinct Hyperdrive configurations', () => {
    const t = readFileSync(join(root, 'apps/api/wrangler.toml'), 'utf8');
    const prodName = /^name = "([^"]+)"/m.exec(t)?.[1]; const stagingName = /\[env\.staging\]\s*\nname = "([^"]+)"/.exec(t)?.[1];
    expect(prodName && stagingName && prodName !== stagingName).toBe(true);
    const hd = [...t.matchAll(/\[\[(?:env\.staging\.)?hyperdrive\]\]\s*\nbinding = "HYPERDRIVE"\s*\nid = "([0-9a-f]+)"/g)].map((m) => m[1]);
    expect(hd.length).toBe(2); expect(hd[0]).not.toBe(hd[1]);
  });
});
