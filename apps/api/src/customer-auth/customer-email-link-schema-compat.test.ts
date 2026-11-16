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
const referencing = (needle: RegExp) => sources.filter((f) => needle.test(f.text)).map((f) => f.path).sort();

describe('S3 schema dependencies (migration 0072 / 0073)', () => {
  const journal = JSON.parse(read('drizzle/meta/_journal.json')) as { entries: Array<{ idx: number; tag: string }> };
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
      'src/customer-auth/customer-email-link.routes.ts',
    ]);
  });

  it('nothing outside the customer-auth session layer constructs the rotating session service', () => {
    expect(referencing(/new CustomerSessionService\(/)).toEqual([]);
  });

  it('only the session service, password service (E10 guard) and credential repository touch the 0072 login state read', () => {
    expect(referencing(/findLegacyLoginState/)).toEqual([
      'src/customer-auth/customer-password-auth.service.ts',
      'src/customer-auth/customer-session.service.ts',
      'src/repositories/customer-credential.repository.ts',
    ]);
  });

  it('the deployed entry point and legacy middleware default do not reference the link flow', () => {
    expect(read('src/index.ts')).not.toMatch(/email-link|EmailLink/);
    const middleware = read('src/middleware/customer-authenticate.ts');
    expect(middleware).toContain('export const customerAuthenticate = createCustomerAuthenticate();');
  });

  it('E10: the phone-proof-only recovery methods have no non-test caller (not activated)', () => {
    expect(referencing(/\.recoverPassword\(/)).toEqual([]);
    expect(referencing(/\.completeRecovery\(/)).toEqual(['src/customer-auth/customer-password-auth.service.ts']);
  });

  it('S4-01: the recovery-code service is internal only (no non-test importer, no entry point reference)', () => {
    // The S4-02 orchestrator is the only importer, and it is itself unreachable (next test).
    expect(referencing(/customer-recovery-code\.service/)).toEqual([
      'src/customer-auth/customer-recovery-attempt.service.ts',
    ]);
    expect(referencing(/createCustomerRecoveryCodeService/)).toEqual([
      'src/customer-auth/customer-recovery-code.service.ts',
    ]);
    expect(read('src/index.ts')).not.toMatch(/recovery-code|RecoveryCode/);
  });

  it('S4-03: the recovery services are reachable from the worker ONLY through the gated router, mounted once', () => {
    const index = read('src/index.ts');
    // exactly one entry point, and it is the gated router
    expect(index.match(/customerRecoveryRoutes/g)?.length).toBe(2); // import + mount
    expect(index).toMatch(/api\.route\('\/customer-recovery', customerRecoveryRoutes\);/);
    expect(index).not.toMatch(/createCustomerRecoveryService|recovery-attempt|recovery-code|recovery-delivery|recovery-config/);
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
    expect(composition).toMatch(/isEnabled: \(c\) => isCustomerRecoveryEnabled\(c\.env as Bindings\)/);
    expect(composition).toMatch(/env\.CUSTOMER_RECOVERY_ENABLED === 'true'/);
    expect(read('src/customer-auth/customer-recovery.routes.ts')).toMatch(/if \(!config\.isEnabled\(c\)\) return notFound\(\);/);
  });
});
