import { describe, expect, it } from 'vitest';
import { ingestPlaywrightReport } from './browser-results';

const spec = (title: string, status: string, over: { mode?: string | null; error?: string; extra?: Array<{ type: string; description: string }> } = {}) => ({
  title,
  tests: [{
    annotations: [...(over.mode === null ? [] : [{ type: 'mode', description: over.mode ?? 'local' }]), ...(over.extra ?? [])],
    results: [{ status, ...(over.error ? { error: { message: over.error } } : {}) }],
  }],
});
const report = (...specs: unknown[]) => ({ config: {}, suites: [{ title: 'file', specs: [], suites: [{ title: 'describe', specs }] }] });

describe('browser report ingestion', () => {
  it('maps passed, failed and skipped to PASS, FAIL and NOT RUN', () => {
    const out = ingestPlaywrightReport(report(spec('B01 cashier signs in', 'passed'), spec('B02 invitation', 'failed', { error: 'expect(received) failed\nstack' }), spec('B03 join', 'skipped', { extra: [{ type: 'skip', description: 'needs a customer session' }] })), 'local');
    expect(out.map((c) => [c.id, c.status])).toEqual([['B01', 'PASS'], ['B02', 'FAIL'], ['B03', 'NOT_RUN']]);
    expect(out[1]?.detail).toBe('expect(received) failed');
    expect(out[2]?.detail).toBe('needs a customer session');
  });
  it('treats timeouts and interruptions as failures, never as passes', () => {
    const out = ingestPlaywrightReport(report(spec('B01 a', 'timedOut'), spec('B02 b', 'interrupted')), 'local');
    expect(out.map((c) => c.status)).toEqual(['FAIL', 'FAIL']);
  });
  it('accepts a check only in the mode of the run: local evidence is never staging evidence', () => {
    const out = ingestPlaywrightReport(report(spec('B01 a', 'passed', { mode: 'local' }), spec('B02 b', 'passed', { mode: null })), 'staging');
    expect(out.every((c) => c.status === 'NOT_RUN')).toBe(true);
    expect(out[0]?.detail).toMatch(/does not match this run's mode "staging"/);
    expect(out[1]?.detail).toMatch(/"missing"/);
  });
  it('numbers repeated ids in order and sorts the result', () => {
    const out = ingestPlaywrightReport(report(spec('B06 overflow (en)', 'passed'), spec('B06 overflow (ar)', 'passed'), spec('B02 x', 'passed')), 'local');
    expect(out.map((c) => c.id)).toEqual(['B02', 'B06', 'B06.2']);
  });
  it('ignores specs that do not declare a scenario id, and reads nested suites', () => {
    const out = ingestPlaywrightReport({ suites: [{ suites: [{ suites: [{ specs: [spec('B09 deep', 'passed'), spec('helper test', 'passed')] }] }] }] }, 'local');
    expect(out.map((c) => c.id)).toEqual(['B09']);
  });
  it('redacts anything sensitive in titles and failure messages', () => {
    const out = ingestPlaywrightReport(report(spec('B01 for user@example.test', 'failed', { error: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefghijklmnop for a@b.co code 123456' })), 'local');
    expect(JSON.stringify(out)).not.toMatch(/user@example\.test|eyJhbGci|a@b\.co|123456/);
  });
  it('rejects anything that is not a Playwright report', () => {
    for (const bad of [null, 'x', {}, { suites: 'no' }, []]) expect(() => ingestPlaywrightReport(bad, 'local')).toThrow(/malformed/);
  });
  it('a spec with no result is NOT RUN, not a pass', () => {
    const out = ingestPlaywrightReport(report({ title: 'B01 none', tests: [{ annotations: [{ type: 'mode', description: 'local' }], results: [] }] }), 'local');
    expect(out[0]?.status).toBe('NOT_RUN');
  });
});
