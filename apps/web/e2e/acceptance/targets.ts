import { readFileSync } from 'node:fs';
import path from 'node:path';
import { guardTargets, parseTargetsConfig } from '../../../api/scripts/acceptance/cashier-02/guard';

/**
 * CASHIER-AUTH-02E E2-C: where the browser acceptance tier may run.
 *
 * `local`  : exactly the local development stack (web on 3000, API on 8787). Nothing else is accepted.
 * `staging`: only the hosts of the harness's committed staging configuration, and only once the owner's approval is recorded there
 *            (the SAME guard the API harness uses, imported, so there is one allow-list). No override of any kind is read.
 * Production hosts, unknown hosts and an unapproved staging configuration are all refused before a browser opens.
 */
export type AcceptanceMode = 'local' | 'staging';

export interface AcceptanceTargets {
  mode: AcceptanceMode;
  web: string;
  cashier: string;
}

const CONFIG = path.join(__dirname, '../../../api/scripts/acceptance/cashier-02/staging-targets.json');

export function resolveTargets(env: Readonly<Record<string, string | undefined>>, readConfig: () => unknown = () => JSON.parse(readFileSync(CONFIG, 'utf8')) as unknown): AcceptanceTargets {
  for (const key of ['E2E_BASE_URL', 'E2E_WEB_URL', 'E2E_CASHIER_URL', 'E2E_ALLOW_PRODUCTION']) {
    if (env[key]) throw new Error('Host overrides are not supported by the acceptance tier; targets come only from the harness configuration.');
  }
  const mode = env.E2E_ACCEPTANCE_MODE;
  if (mode === 'local') return { mode, web: 'http://localhost:3000', cashier: 'http://localhost:3000' };
  if (mode === 'staging') {
    const config = parseTargetsConfig(readConfig());
    guardTargets(config, { requireApproval: true }); // throws LIVE_NOT_APPROVED until the owner records the approval
    return { mode, web: `https://${config.targets.web.host}`, cashier: `https://${config.targets.cashier.host}` };
  }
  throw new Error('E2E_ACCEPTANCE_MODE must be "local" or "staging".');
}
