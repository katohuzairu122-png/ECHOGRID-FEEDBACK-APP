import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findSecretLeaks, redactString } from './redact';

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN';
export type RunState = 'COMPLETE' | 'INTERRUPTED' | 'BLOCKED';

export interface CheckResult {
  scenario: string;
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  mode: string;
  commit: string;
  state: RunState;
  counts: { pass: number; fail: number; notRun: number };
  checks: CheckResult[];
  /** sha256 of the stable body (everything except itself): identical inputs give an identical hash. */
  reportHash: string;
}

/** Exit codes: 0 every runnable check passed; 1 a check failed; 2 blocked by a safety refusal; 3 interrupted. */
export function exitCodeFor(report: Pick<RunReport, 'state' | 'counts'>, opts: { requireAll?: boolean } = {}): number {
  if (report.state === 'BLOCKED') return 2;
  if (report.state === 'INTERRUPTED') return 3;
  if (report.counts.fail > 0) return 1;
  if (opts.requireAll && report.counts.notRun > 0) return 1;
  return 0;
}

const naturalKey = (id: string) => id.replace(/\d+/g, (n) => n.padStart(4, '0'));

/** Stable JSON: keys sorted at every level, so the same report always serialises to the same bytes. */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

export class ResultBook {
  private readonly checks: CheckResult[] = [];
  constructor(
    readonly meta: { runId: string; mode: string; commit: string },
    private readonly onCheck?: (check: CheckResult) => void | Promise<void>,
  ) {}

  /** Free text is redacted on the way in, so no caller can store a secret by accident. */
  async add(scenario: string, id: string, title: string, status: CheckStatus, detail = ''): Promise<void> {
    const check: CheckResult = { scenario, id, title: redactString(title), status, detail: redactString(detail).slice(0, 300) };
    this.checks.push(check);
    await this.onCheck?.(check);
  }

  finalize(state: RunState): RunReport {
    const checks = [...this.checks].sort((a, b) => (naturalKey(a.id) < naturalKey(b.id) ? -1 : naturalKey(a.id) > naturalKey(b.id) ? 1 : 0));
    const counts = {
      pass: checks.filter((c) => c.status === 'PASS').length,
      fail: checks.filter((c) => c.status === 'FAIL').length,
      notRun: checks.filter((c) => c.status === 'NOT_RUN').length,
    };
    const body = { schemaVersion: 1 as const, ...this.meta, state, counts, checks };
    const reportHash = createHash('sha256').update(stableStringify(body)).digest('hex');
    return { ...body, reportHash };
  }
}

const RUN_FILE = /^[a-z0-9]{4,12}$/;

/** Appends one redacted line per check as it happens, so an interrupted run still leaves its evidence. */
export function createJournal(dir: string, runId: string): (check: CheckResult) => Promise<void> {
  if (!RUN_FILE.test(runId)) throw new Error('invalid run id');
  const file = path.join(dir, `${runId}.journal.jsonl`);
  return async (check) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(check)}\n`, { flag: 'a' });
  };
}

/** Writes the final report once; never overwrites; refuses if any sensitive material is still present. */
export async function writeReport(dir: string, report: RunReport): Promise<string> {
  const text = `${stableStringify(report)}\n`;
  // The report hash and the commit are long hexadecimal strings by nature and are not secrets; they are validated, then excluded from the scan.
  if (!/^[0-9a-f]{64}$/.test(report.reportHash) || !/^([0-9a-f]{7,40}|unknown)$/.test(report.commit)) throw new Error('refusing to write a result file with a malformed hash or commit');
  const leaks = findSecretLeaks(stableStringify({ ...report, reportHash: '', commit: '' }));
  if (leaks.length > 0) throw new Error(`refusing to write a result file containing sensitive material (${leaks.join(', ')})`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${report.runId}.json`);
  await fs.writeFile(file, text, { flag: 'wx' });
  return file;
}

/** Runs that started but never wrote a final report. They are reported, never resumed, deleted or reused. */
export async function findInterruptedRuns(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const finals = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
  return names
    .filter((n) => n.endsWith('.journal.jsonl'))
    .map((n) => n.slice(0, -'.journal.jsonl'.length))
    .filter((id) => !finals.has(id))
    .sort();
}
