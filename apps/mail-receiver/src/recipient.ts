/** The ONLY addresses the receiver will ever hold mail for: `acc-<run>-<label>@<approved test domain>`. Exact match, lowercase. */
export interface Recipient {
  address: string;
  runId: string;
  label: string;
}

export function parseRecipient(address: unknown, approvedDomain: string): Recipient | null {
  if (typeof address !== 'string' || address.length > 64) return null;
  const lower = address.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1 || lower.slice(at + 1) !== approvedDomain) return null;
  const m = /^acc-([a-z0-9]{4,12})-([a-z0-9]{1,16})$/.exec(lower.slice(0, at));
  if (!m) return null;
  return { address: lower, runId: m[1] as string, label: m[2] as string };
}
