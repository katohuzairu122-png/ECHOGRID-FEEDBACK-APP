import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectB4BranchReadPath } from './branch-read-runtime-gate';

describe('Gate 2 B4-04 guarded branch-read selection', () => {
  it('retains existing branch read by default', () => {
    expect(selectB4BranchReadPath()).toBe('existing-route');
  });

  it('refuses explicit broker activation rather than falling back or querying', () => {
    expect(() => selectB4BranchReadPath('broker')).toThrowError(
      'Restricted branch-read broker is not certified or available.',
    );
    try {
      selectB4BranchReadPath('broker');
      throw Error('gate unexpectedly opened');
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: 'B4_BROKER_NOT_CERTIFIED' });
    }
  });

  it('rejects unknown or malformed runtime mode at the same boundary', () => {
    for (const mode of ['shadow', 'enabled', '', 'production', 'broker?tenant=B', null]) {
      expect(() => selectB4BranchReadPath(mode as 'broker')).toThrow();
    }
  });

  it('does not expose an environment or request-controlled activation path', () => {
    const source = readFileSync(fileURLToPath(new URL('./branch-read-runtime-gate.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/process\.env|c\.req\.|c\.env\.|\.get\('x-|import\s.*branch-broker-read/);
    expect(source).toContain("requested !== 'existing-route'");
  });

  it('preserves preexisting authentication and route authorization middleware', () => {
    const source = readFileSync(fileURLToPath(new URL('./branch.routes.ts', import.meta.url)), 'utf8');
    expect(source).toContain("branchRoutes.use('*', authenticate, resolveTenantContext)");
    expect(source).toContain(
      "branchRoutes.get('/:id', requireAuthorizedBranchParam(), requirePermission('branches:view')",
    );
    expect(source).toContain('selectB4BranchReadPath();');
    expect(source).toContain('new BranchService(createRepositories(db))');
    expect(source).not.toContain('readOneBranchViaBroker(');
  });
});
