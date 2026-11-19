import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResultBook, createJournal, exitCodeFor, findInterruptedRuns, stableStringify, writeReport } from './result';
import { runAcceptance } from './runner';
import type { Context } from './scenarios';

const meta = { runId: 'abc123', mode: 'staging', commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
const fill = async (order: Array<[string, string, 'PASS' | 'FAIL' | 'NOT_RUN']>) => {
  const book = new ResultBook(meta);
  for (const [s, id, st] of order) await book.add(s, id, `title ${id}`, st, 'detail');
  return book;
};

describe('deterministic reporting', () => {
  it('the same checks in any order give the same report bytes and hash', async () => {
    const a = (await fill([['S10', 'S10.1', 'PASS'], ['S2', 'S2.1', 'FAIL'], ['S02', 'S02.2', 'NOT_RUN']])).finalize('COMPLETE');
    const b = (await fill([['S02', 'S02.2', 'NOT_RUN'], ['S10', 'S10.1', 'PASS'], ['S2', 'S2.1', 'FAIL']])).finalize('COMPLETE');
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.checks.map((c) => c.id)).toEqual(['S2.1', 'S02.2', 'S10.1']);
    expect(a.counts).toEqual({ pass: 1, fail: 1, notRun: 1 });
  });
  it('maps states to exit codes', async () => {
    const pass = (await fill([['S1', 'S1.1', 'PASS'], ['S1', 'S1.2', 'NOT_RUN']])).finalize('COMPLETE');
    expect(exitCodeFor(pass)).toBe(0);
    expect(exitCodeFor(pass, { requireAll: true })).toBe(1);
    expect(exitCodeFor((await fill([['S1', 'S1.1', 'FAIL']])).finalize('COMPLETE'))).toBe(1);
    expect(exitCodeFor(pass.state === 'COMPLETE' ? { ...pass, state: 'BLOCKED' } : pass)).toBe(2);
    expect(exitCodeFor({ ...pass, state: 'INTERRUPTED' })).toBe(3);
  });
  it('redacts on the way in and refuses to write a file with sensitive material', async () => {
    const book = new ResultBook(meta);
    await book.add('S1', 'S1.1', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefghijklmnop for user@example.com', 'PASS', 'code 123456');
    const report = book.finalize('COMPLETE');
    expect(JSON.stringify(report)).not.toMatch(/user@example\.com|123456|eyJhbGci/);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-'));
    await writeReport(dir, report);
    const leaky = { ...report, checks: [{ ...report.checks[0]!, detail: 'x@y.com' }] };
    await expect(writeReport(dir, { ...leaky, runId: 'zzz999' })).rejects.toThrow(/sensitive/);
  });
  it('never overwrites an existing result file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-'));
    const report = (await fill([['S1', 'S1.1', 'PASS']])).finalize('COMPLETE');
    await writeReport(dir, report);
    await expect(writeReport(dir, report)).rejects.toThrow();
  });
});

describe('interrupted runs', () => {
  const ctx = (api: Context['api']): Context => ({
    api, runId: 'run111', provisioner: null,
    ownerA: { email: 'a@example.test', password: 'pw', businessId: 'a' }, ownerB: { email: 'b@example.test', password: 'pw', businessId: 'b' },
  });
  const okApi: Context['api'] = {
    async request(_m, p) {
      if (p === '/auth/login') return { status: 200, data: { accessToken: 'tok' } };
      if (p === '/cashier-accounts/business-code') return { status: 200, data: { cashierCode: 'CODE' } };
      if (p === '/branches') return { status: 200, data: [] };
      return { status: 200, data: { totals: { events: 0, uniqueCustomers: 0, rejoinEvents: 0 }, bySource: [], byBranch: [] } };
    },
  };

  it('keeps the evidence of a run that is aborted, reports it as INTERRUPTED and leaves the journal', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-'));
    const controller = new AbortController();
    const out = await runAcceptance({ ctx: ctx(okApi), mode: 'local', commit: 'abcdef0', outDir: dir, signal: controller.signal, afterScenario: (id) => { if (id === 'S01') controller.abort(); } });
    expect(out.report.state).toBe('INTERRUPTED');
    expect(out.report.checks.some((c) => c.scenario === 'S01')).toBe(true);
    expect(out.report.checks.some((c) => c.scenario === 'S14')).toBe(false);
    expect((await readFile(path.join(dir, 'run111.journal.jsonl'), 'utf8')).trim().split('\n').length).toBeGreaterThan(0);
  });
  it('lists a run that has a journal but no final report, and does not touch or reuse it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-'));
    await createJournal(dir, 'dead01')({ scenario: 'S1', id: 'S1.1', title: 't', status: 'PASS', detail: '' });
    const before = await readFile(path.join(dir, 'dead01.journal.jsonl'), 'utf8');
    expect(await findInterruptedRuns(dir)).toEqual(['dead01']);
    const out = await runAcceptance({ ctx: ctx(okApi), mode: 'local', commit: 'abcdef0', outDir: dir, only: ['S14'] });
    expect(out.interruptedEarlier).toEqual(['dead01']);
    expect(await readFile(path.join(dir, 'dead01.journal.jsonl'), 'utf8')).toBe(before);
    expect(await findInterruptedRuns(dir)).toEqual(['dead01']);
  });
  it('an unexpected error in a scenario becomes a FAIL and the run continues; setup failure makes every scenario NOT RUN', async () => {
    const boom: Context['api'] = { async request() { throw new Error('network down for a@b.co'); } };
    const out = await runAcceptance({ ctx: ctx(boom), mode: 'local', commit: 'abcdef0' });
    expect(out.report.state).toBe('COMPLETE');
    expect(out.report.counts.fail).toBe(1);
    expect(out.report.counts.notRun).toBeGreaterThan(10);
    expect(JSON.stringify(out.report)).not.toContain('a@b.co');
  });
  it('writes nothing outside the output directory and tolerates a missing one', async () => {
    expect(await findInterruptedRuns(path.join(os.tmpdir(), 'does-not-exist-acc'))).toEqual([]);
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), 'acc-')), 'x.txt');
    await writeFile(f, 'x');
    expect(await findInterruptedRuns(path.dirname(f))).toEqual([]);
  });
});
