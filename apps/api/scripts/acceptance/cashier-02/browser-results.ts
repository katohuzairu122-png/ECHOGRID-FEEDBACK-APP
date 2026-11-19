import { redactString } from './redact';

/**
 * CASHIER-AUTH-02E E2-D: ingestion of the browser tier's Playwright JSON report.
 *
 * Browser evidence is only as good as where it was gathered, so every test records its mode (`local` or `staging`) in an annotation and
 * ingestion accepts a check only when that mode equals the mode of the run. A local browser pass can never become staging evidence:
 * it is reported NOT RUN with that reason. Free text is redacted; nothing but ids, titles, statuses and a short redacted detail is kept.
 */
export type BrowserStatus = 'PASS' | 'FAIL' | 'NOT_RUN';
export interface BrowserCheck {
  id: string;
  title: string;
  status: BrowserStatus;
  detail: string;
}
export type BrowserMode = 'local' | 'staging';

const MAX_BYTES = 5_000_000;
const TITLE = /^(B\d{2})\b\s*[:\-–]?\s*(.*)$/;

interface PwAnnotation { type?: unknown; description?: unknown }
interface PwResult { status?: unknown; error?: { message?: unknown } }
interface PwTest { annotations?: unknown; results?: unknown }
interface PwSpec { title?: unknown; tests?: unknown }
interface PwSuite { specs?: unknown; suites?: unknown }

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function collectSpecs(suite: PwSuite, out: PwSpec[]): void {
  for (const spec of asArray(suite.specs)) out.push(spec as PwSpec);
  for (const child of asArray(suite.suites)) collectSpecs(child as PwSuite, out);
}

export function ingestPlaywrightReport(report: unknown, expectedMode: BrowserMode): BrowserCheck[] {
  if (typeof report !== 'object' || report === null || !Array.isArray((report as { suites?: unknown }).suites)) {
    throw new Error('malformed browser report: expected a Playwright JSON report');
  }
  if (JSON.stringify(report).length > MAX_BYTES) throw new Error('malformed browser report: too large');
  const specs: PwSpec[] = [];
  for (const suite of asArray((report as { suites: unknown }).suites)) collectSpecs(suite as PwSuite, specs);
  const seen = new Map<string, number>();
  const checks: BrowserCheck[] = [];
  for (const spec of specs) {
    const title = typeof spec.title === 'string' ? spec.title : '';
    const m = TITLE.exec(title);
    if (!m) continue; // only specs that declare a scenario id take part
    const n = (seen.get(m[1] as string) ?? 0) + 1;
    seen.set(m[1] as string, n);
    const id = n === 1 ? (m[1] as string) : `${m[1]}.${n}`;
    const test = asArray(spec.tests)[0] as PwTest | undefined;
    const results = asArray(test?.results) as PwResult[];
    const last = results[results.length - 1];
    const annotations = asArray(test?.annotations) as PwAnnotation[];
    const mode = annotations.find((a) => a.type === 'mode')?.description;
    const label = redactString(m[2] as string).slice(0, 160);
    if (mode !== expectedMode) {
      checks.push({ id, title: label, status: 'NOT_RUN', detail: `evidence mode "${typeof mode === 'string' ? mode : 'missing'}" does not match this run's mode "${expectedMode}": it is not accepted as ${expectedMode} evidence` });
      continue;
    }
    const status = last?.status;
    if (status === 'passed') checks.push({ id, title: label, status: 'PASS', detail: '' });
    else if (status === 'skipped' || last === undefined) {
      const reason = annotations.find((a) => a.type === 'skip' || a.type === 'reason')?.description;
      checks.push({ id, title: label, status: 'NOT_RUN', detail: redactString(typeof reason === 'string' ? reason : 'skipped').slice(0, 200) });
    } else {
      const message = typeof last.error?.message === 'string' ? (last.error.message.split('\n')[0] ?? '') : String(status);
      checks.push({ id, title: label, status: 'FAIL', detail: redactString(message).slice(0, 200) });
    }
  }
  return checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
