import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config';
import { MailboxStore, type ClaimResult, type PutResult, type StoredMessage } from './store';

/** One object per exact recipient address (`idFromName(address)`): messages for different recipients can never meet. */
export class MailboxDurableObject extends DurableObject<Env> {
  private readonly store: MailboxStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MailboxStore(ctx.storage);
  }

  async put(input: StoredMessage & { messageIdHash: string }, nowMs: number): Promise<PutResult> {
    const result = this.store.put(input, nowMs);
    await this.schedule(nowMs);
    return result;
  }

  async claim(runId: string, nonce: string, nowMs: number): Promise<ClaimResult> {
    const result = this.store.claim(runId, nonce, nowMs);
    await this.schedule(nowMs);
    return result;
  }

  override async alarm(): Promise<void> {
    await this.schedule(Date.now());
  }

  /** Sweeps, then either sets the next alarm or removes the object's storage entirely when nothing is left. */
  private async schedule(nowMs: number): Promise<void> {
    const next = this.store.sweep(nowMs);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next, nowMs + 1_000));
  }
}

/** A single object that bounds how much mail the whole receiver accepts, so unsolicited volume cannot exhaust storage. */
export class IngestLimiterDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS buckets (bucket INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
  }

  admit(limit: number, nowMs: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const bucket = Math.floor(nowMs / 600_000);
      sql.exec('DELETE FROM buckets WHERE bucket < ?', bucket);
      const row = sql.exec('SELECT n FROM buckets WHERE bucket = ?', bucket).toArray()[0];
      const n = (row?.n as number | undefined) ?? 0;
      if (n >= limit) return false;
      sql.exec('INSERT INTO buckets (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1', bucket);
      return true;
    });
  }
}
