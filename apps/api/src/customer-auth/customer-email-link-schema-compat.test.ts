import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R1 / F3. Static guards for the S3 email-link development artifacts. They do
 * not touch a database. They pin: (1) the schema objects S3 needs come from
 * migrations 0072 and 0073, in that order; (2) nothing the deployed Worker
 * imports can reach those columns until a separate activation block mounts it.
 */
const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(API_ROOT, path), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}
const sources = sourceFiles(join(API_ROOT, 'src')).map((full) => ({
  path: relative(API_ROOT, full).split('\\').join('/'),
  text: readFileSync(full, 'utf8'),
}));
const referencing = (needle: RegExp) =>
  sources
    .filter((f) => needle.test(f.text))
    .map((f) => f.path)
    .sort();

describe('S3 schema dependencies (migration 0072 / 0073)', () => {
  const journal = JSON.parse(read('drizzle/meta/_journal.json')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entry = (prefix: string) => journal.entries.find((e) => e.tag.startsWith(prefix));

  it('lists 0072 before 0073, and both after 0068 (credentials table)', () => {
    const [i68, i72, i73] = [entry('0068_'), entry('0072_'), entry('0073_')];
    expect(i68 && i72 && i73).toBeTruthy();
    expect(i68!.idx).toBeLessThan(i72!.idx);
    expect(i72!.idx).toBeLessThan(i73!.idx);
  });

  it('0072 introduces the verified login email columns S3 reads and writes', () => {
    const sql = read('drizzle/0072_customer_verified_login_email.sql');
    expect(sql).toContain('ADD COLUMN "login_email" text');
    expect(sql).toContain('ADD COLUMN "login_email_verified_at"');
    expect(sql).toContain('customer_credentials_login_email_uidx');
  });

  it('0073 introduces the challenge table and nullable phone S3 relies on', () => {
    const sql = read('drizzle/0073_customer_phone_free_challenges.sql');
    expect(sql).toContain('customer_auth_challenges');
    expect(sql).toMatch(/"phone"[^;]*DROP NOT NULL/);
  });
});

describe('S3 stays unreachable from the deployed Worker until activation', () => {
  it('only the isolated email-link composition imports the link service or routes', () => {
    expect(referencing(/customer-email-link\.(service|routes)/)).toEqual([
      'src/customer-auth/customer-email-link.composition.ts',
      'src/customer-auth/customer-email-link.routes.ts',
    ]);
  });

  it('S5-01..S5-03: the rotating session service is constructed ONLY by the three flag-gated entry points, each gated and mounted once', () => {
    // Activation was approved (Option A) but stays behind CUSTOMER_EMAIL_AUTH_ENABLED: exactly three non-test constructors,
    // the email-auth composition (issues sessions), the session lifecycle composition (refresh, logout) and the customer
    // middleware (verifies them).
    expect(referencing(/new CustomerSessionService\(/)).toEqual([
      'src/customer-auth/customer-email-auth.composition.ts',
      'src/customer-auth/customer-email-link.composition.ts',
      'src/customer-auth/customer-recovery.composition.ts',
      'src/customer-auth/customer-session-lifecycle.composition.ts',
      'src/middleware/customer-authenticate.ts',
    ]);
    expect(read('src/customer-auth/customer-session-lifecycle.composition.ts')).toMatch(
      /isEnabled: \(c\) => isCustomerEmailAuthEnabled\(c\.env as Bindings\)/,
    );
    expect(read('src/index.ts')).toMatch(
      /api\.route\('\/customer-session', customerSessionLifecycleComposition\);/,
    );
    const middlewareSource = read('src/middleware/customer-authenticate.ts');
    expect(middlewareSource).toMatch(
      /isEnabled: \(c\) => isCustomerEmailAuthEnabled\(c\.env as Bindings\)/,
    );
    expect(middlewareSource).toContain(
      'export const legacyCustomerAuthenticate = createCustomerAuthenticate();',
    );
    const composition = read('src/customer-auth/customer-email-auth.composition.ts');
    expect(composition).toMatch(
      /isEnabled: \(c\) => isCustomerEmailAuthEnabled\(c\.env as Bindings\)/,
    );
    expect(read('src/customer-auth/customer-email-auth.config.ts')).toMatch(
      /CUSTOMER_EMAIL_AUTH_ENABLED === 'true'/,
    );
    const index = read('src/index.ts');
    expect(index.match(/customerEmailAuthComposition/g)?.length).toBe(2); // import + mount
    expect(index).toMatch(/api\.route\('\/customer-auth', customerEmailAuthComposition\);/);
    expect(index.match(/customerEmailLinkComposition/g)?.length).toBe(2); // import + isolated mount
    expect(index).toMatch(/api\.route\('\/customer-auth', customerEmailLinkComposition\);/);
    const emailLinkComposition = read('src/customer-auth/customer-email-link.composition.ts');
    expect(emailLinkComposition).toMatch(
      /env\.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && env\.CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true'/,
    );
    // The legacy-only verifier is preserved verbatim and is what runs whenever the flag is off.
    expect(read('src/middleware/customer-authenticate.ts')).toContain(
      'if (!options.isEnabled(c)) return legacyCustomerAuthenticate(c, next);',
    );
  });

  it('only the session service, password service (E10 guard) and credential repository touch the 0072 login state read', () => {
    expect(referencing(/findLegacyLoginState/)).toEqual([
      'src/customer-auth/customer-password-auth.service.ts',
      'src/customer-auth/customer-session.service.ts',
      'src/repositories/customer-credential.repository.ts',
    ]);
  });

  it('the link route is isolated behind its own exact-string upgrade gate', () => {
    const index = read('src/index.ts');
    expect(index).toMatch(/customerEmailLinkComposition/);
    const link = read('src/customer-auth/customer-email-link.composition.ts');
    expect(link).toMatch(
      /CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && env\.CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true'/,
    );
    expect(link).toMatch(
      /if \(!options\.isEnabled\(c\)\) return c\.json\(\{ error: 'Not Found' \}, 404\)/,
    );
    const middleware = read('src/middleware/customer-authenticate.ts');
    expect(middleware).toContain(
      'export const legacyCustomerAuthenticate = createCustomerAuthenticate();',
    );
  });

  it('E10: the phone-proof-only recovery methods have no non-test caller (not activated)', () => {
    expect(referencing(/\.recoverPassword\(/)).toEqual([]);
    expect(referencing(/\.completeRecovery\(/)).toEqual([
      'src/customer-auth/customer-password-auth.service.ts',
    ]);
  });

  it('S4-01: recovery-code operations are reachable only through the gated recovery composition', () => {
    expect(referencing(/customer-recovery-code\.service/)).toEqual([
      'src/customer-auth/customer-recovery-attempt.service.ts',
      'src/customer-auth/customer-recovery.composition.ts',
    ]);
    expect(referencing(/createCustomerRecoveryCodeService/)).toEqual([
      'src/customer-auth/customer-recovery-code.service.ts',
      'src/customer-auth/customer-recovery.composition.ts',
    ]);
    expect(read('src/index.ts')).not.toMatch(/recovery-code|RecoveryCode/);
  });

  it('S4-03: the recovery services are reachable from the worker ONLY through the gated router, mounted once', () => {
    const index = read('src/index.ts');
    // exactly one entry point, and it is the gated router
    expect(index.match(/customerRecoveryRoutes/g)?.length).toBe(2); // import + mount
    expect(index).toMatch(/api\.route\('\/customer-recovery', customerRecoveryRoutes\);/);
    expect(index).not.toMatch(
      /createCustomerRecoveryService|recovery-attempt|recovery-code|recovery-delivery|recovery-config/,
    );
    // the orchestrator is imported only by the composition root, the routes' type and the delivery adapters' types
    expect(referencing(/from ['"][^'"]*customer-recovery-attempt\.service['"]/)).toEqual([
      'src/customer-auth/customer-recovery-delivery.ts',
      'src/customer-auth/customer-recovery.composition.ts',
      'src/customer-auth/customer-recovery.routes.ts',
    ]);
    // defined in the service, constructed only by the composition root
    expect(referencing(/createCustomerRecoveryService\(/)).toEqual([
      'src/customer-auth/customer-recovery-attempt.service.ts',
      'src/customer-auth/customer-recovery.composition.ts',
    ]);
    expect(referencing(/from ['"][^'"]*customer-recovery-config['"]/)).toEqual([
      'src/customer-auth/customer-recovery-attempt.service.ts',
      'src/customer-auth/customer-recovery.composition.ts',
    ]);
    // and the router refuses everything unless the explicit gate is on
    const composition = read('src/customer-auth/customer-recovery.composition.ts');
    expect(composition).toMatch(
      /isEnabled: \(c\) => isCustomerRecoveryEnabled\(c\.env as Bindings\)/,
    );
    expect(composition).toMatch(
      /CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && env\.CUSTOMER_RECOVERY_ENABLED === 'true'/,
    );
    expect(read('src/customer-auth/customer-recovery.routes.ts')).toMatch(
      /if \(!config\.isEnabled\(c\)\) return notFound\(\);/,
    );
  });
});
