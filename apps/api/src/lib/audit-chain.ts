import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Canonical JSON: sorted keys at EVERY depth (a top-level key-list replacer would silently drop nested fields from the hash). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') { if (v === undefined || typeof v === 'function' || typeof v === 'symbol') throw new TypeError('Not canonicalizable'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export interface AuditLink { readonly prev: string | null; readonly hash: string; readonly event: Record<string, unknown> }

/** Hash-chained audit entry (tamper-evident ordering of selection events); the full event, at every depth, is committed. */
export function chainAudit(prevHash: string | null, event: Record<string, unknown>): AuditLink {
  return { prev: prevHash, event, hash: sha(`${prevHash ?? 'GENESIS'}:${canonicalJson(event)}`) };
}

/** Recomputes the whole chain: detects an altered, removed, inserted or reordered link. */
export function verifyChain(links: readonly AuditLink[]): boolean {
  let prev: string | null = null;
  for (const l of links) { if (l.prev !== prev || chainAudit(prev, l.event).hash !== l.hash) return false; prev = l.hash; }
  return true;
}
