import { chmodSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { stripeEvidenceKeys, stripeProviderEventConflicts, stripeProviderEvents, stripeProviderMalformedReceipts } from '../../db/schema';
import { ControlEventWriter } from './control-events';
import { EvidenceCryptoError, openPayload, unwrapDek } from './envelope';
import { eventIdentity } from './evidence.store';
import type { LoadedKeyring } from './keyring';

/**
 * HETA-01-F1 B5/C.6: the ONLY module that decrypts stored evidence. OPERATOR / forensic use, never an HTTP route and
 * never in the Worker request path. Every access is audited BEFORE any plaintext is returned (fail closed: if the audit
 * row cannot be written, nothing is decrypted). Audit rows carry actor, purpose, record identity and an approval
 * reference; never payload, keys or file paths. Exports of plaintext are registered and their destruction is recorded.
 * A failed decryption returns no partial plaintext and says only that THIS keyring could not decrypt it.
 */
export class ForensicAccessError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'KEK_UNAVAILABLE' | 'AUDIT_FAILED' | 'BAD_AUDIT_CONTEXT' | 'EXPORT_EXISTS' | 'EXPORT_MISSING') {
    super(`Forensic access failure: ${code}`);
    this.name = 'ForensicAccessError';
  }
}

export interface AuditContext {
  /** Named custodian (H9). */
  actor: string;
  /** Why the plaintext is needed (<= 200 chars). */
  reason: string;
  approvalRef?: string | undefined;
}

export type EvidenceTable = 'stripe_provider_events' | 'stripe_provider_malformed_receipts' | 'stripe_provider_event_conflicts';

const hex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');

function checkContext(c: AuditContext): void {
  if (!c.actor.trim() || !c.reason.trim() || c.reason.length > 200) throw new ForensicAccessError('BAD_AUDIT_CONTEXT');
}

export class ForensicReader {
  private readonly control: ControlEventWriter;
  constructor(private readonly db: Database, private readonly keyring: LoadedKeyring) {
    this.control = new ControlEventWriter(db);
  }

  private async audit(mode: 'read' | 'export', table: EvidenceTable, recordId: string, ctx: AuditContext, extra: Record<string, unknown> = {}): Promise<void> {
    checkContext(ctx);
    try {
      await this.control.append({
        kind: 'forensic_export_registered', actor: ctx.actor, approvalRef: ctx.approvalRef,
        details: { mode, table, recordId, reason: ctx.reason, ...extra },
      });
    } catch {
      throw new ForensicAccessError('AUDIT_FAILED');
    }
  }

  private async dekFor(cohort: string): Promise<CryptoKey> {
    const rows = await this.db.select().from(stripeEvidenceKeys).where(eq(stripeEvidenceKeys.cohort, cohort));
    for (const r of rows) {
      const kek = this.keyring.find(r.cohort, r.kekVersion);
      if (!kek) continue;
      try {
        return await unwrapDek(kek.key, { wrappedDek: r.wrappedDek, wrapNonce: r.wrapNonce, dekFingerprint: r.dekFingerprint }, r.cohort, r.kekVersion);
      } catch (e) {
        if (!(e instanceof EvidenceCryptoError)) throw e;
      }
    }
    throw new ForensicAccessError('KEK_UNAVAILABLE');
  }

  /** Audited read of one captured event's exact original bytes. */
  async readEvent(eventRecordId: string, ctx: AuditContext): Promise<Uint8Array> {
    const row = (await this.db.select().from(stripeProviderEvents).where(eq(stripeProviderEvents.id, eventRecordId)))[0];
    if (!row) throw new ForensicAccessError('NOT_FOUND');
    await this.audit('read', 'stripe_provider_events', eventRecordId, ctx, { provenance: row.provenance });
    const dek = await this.dekFor(row.payloadKeyCohort);
    return openPayload(dek, { ciphertext: row.payloadCiphertext, nonce: row.payloadNonce, payloadSha256: row.payloadSha256 }, {
      table: 'stripe_provider_events', identity: eventIdentity(row), cohort: row.payloadKeyCohort, kekVersion: row.kekVersion,
    });
  }

  /** Audited read of an authenticated-but-malformed body. */
  async readMalformed(receiptId: string, ctx: AuditContext): Promise<Uint8Array> {
    const row = (await this.db.select().from(stripeProviderMalformedReceipts).where(eq(stripeProviderMalformedReceipts.id, receiptId)))[0];
    if (!row) throw new ForensicAccessError('NOT_FOUND');
    await this.audit('read', 'stripe_provider_malformed_receipts', receiptId, ctx);
    const dek = await this.dekFor(row.payloadKeyCohort);
    return openPayload(dek, { ciphertext: row.payloadCiphertext, nonce: row.payloadNonce, payloadSha256: row.payloadSha256 }, {
      table: 'stripe_provider_malformed_receipts', identity: hex(row.payloadSha256), cohort: row.payloadKeyCohort, kekVersion: row.kekVersion,
    });
  }

  /** Audited read of the conflicting body kept by a digest or provider-field conflict. */
  async readConflict(conflictId: string, ctx: AuditContext): Promise<Uint8Array> {
    const row = (await this.db.select().from(stripeProviderEventConflicts).where(eq(stripeProviderEventConflicts.id, conflictId)))[0];
    if (!row) throw new ForensicAccessError('NOT_FOUND');
    await this.audit('read', 'stripe_provider_event_conflicts', conflictId, ctx, { conflictKind: row.conflictKind });
    const dek = await this.dekFor(row.payloadKeyCohort);
    return openPayload(dek, { ciphertext: row.payloadCiphertext, nonce: row.payloadNonce, payloadSha256: row.conflictingSha256 }, {
      table: 'stripe_provider_event_conflicts', identity: `${row.eventRecordId}|${row.conflictKind}|${hex(row.conflictingSha256)}`, cohort: row.payloadKeyCohort, kekVersion: row.kekVersion,
    });
  }

  /**
   * Writes the plaintext of one event to a NEW 0600 file and registers the export (so C.6 can require its destruction).
   * `locationLabel` is a non-secret name for where the file lives; the path itself is not recorded.
   */
  async exportEventToFile(eventRecordId: string, ctx: AuditContext, path: string, locationLabel: string): Promise<{ exportLabel: string }> {
    if (existsSync(path)) throw new ForensicAccessError('EXPORT_EXISTS');
    const plaintext = await this.readEvent(eventRecordId, ctx); // audited read first
    const exportLabel = crypto.randomUUID();
    await this.audit('export', 'stripe_provider_events', eventRecordId, ctx, { exportLabel, locationLabel, file: basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) });
    writeFileSync(path, plaintext, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return { exportLabel };
  }

  /** Overwrites and removes an exported file, then records `forensic_export_destroyed`. Best-effort sanitization; the record is what C.6 audits. */
  async destroyExport(path: string, exportLabel: string, ctx: AuditContext): Promise<void> {
    checkContext(ctx);
    if (!existsSync(path)) throw new ForensicAccessError('EXPORT_MISSING');
    const size = statSync(path).size;
    writeFileSync(path, new Uint8Array(size)); // zero-fill before unlink
    unlinkSync(path);
    await this.control.append({ kind: 'forensic_export_destroyed', actor: ctx.actor, approvalRef: ctx.approvalRef, dedupeKey: `fexd:${exportLabel}`, details: { exportLabel, reason: ctx.reason } });
  }
}

/** Read-only listing helper for operators: identifies evidence rows without decrypting anything. */
export async function listEventRecords(db: Database, receivingAccountId: string, stripeEventId: string): Promise<{ id: string; provenance: string; payloadSha256Hex: string }[]> {
  const rows = await db.select({ id: stripeProviderEvents.id, provenance: stripeProviderEvents.provenance, d: stripeProviderEvents.payloadSha256 })
    .from(stripeProviderEvents)
    .where(and(eq(stripeProviderEvents.receivingAccountId, receivingAccountId), eq(stripeProviderEvents.stripeEventId, stripeEventId)));
  return rows.map(r => ({ id: r.id, provenance: r.provenance, payloadSha256Hex: hex(r.d) }));
}
