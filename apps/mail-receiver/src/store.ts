import { MESSAGE_LIFETIME_MS } from './protocol';

/**
 * CASHIER-AUTH-02E E2D: the per-recipient message store, run INSIDE one Durable Object (one object per exact recipient address).
 *
 * Why this storage: a Durable Object runs its methods one at a time over strongly consistent SQLite, and `transactionSync` makes a
 * multi-statement change all-or-nothing. A claim is "select the live messages, delete them, return them" in ONE transaction, so at most one
 * caller can ever receive a given message, even under simultaneous requests, and a failure part-way rolls back (the message stays claimable
 * rather than being half-consumed or handed out twice). KV was rejected (eventually consistent reads and deletes cannot give single use);
 * D1 would work but gives no per-recipient serialization or timers, and cleanup would need a separate scheduler.
 *
 * Every read applies the expiry itself (`expires_at > now`), so an expired message is never returned even if cleanup has not run yet.
 * Time is passed in by the Worker (one clock, and tests can be exact). Nothing here logs.
 */
export const MAX_MESSAGES_PER_RECIPIENT = 5;
export const MAX_CLAIMS_PER_MINUTE = 30;
export const NONCE_TTL_MS = 120_000;
const SEEN_TTL_MS = 30 * 60_000;
const RATE_WINDOW_MS = 60_000;

export interface StoredMessage {
  to: string;
  runId: string;
  receivedAtMs: number;
  text: string;
}

export type PutResult = 'stored' | 'duplicate' | 'full';
export type ClaimResult = { kind: 'claimed'; messages: StoredMessage[] } | { kind: 'replay' } | { kind: 'rate_limited' };

export interface StoreHooks {
  /** Test-only fault injection, called inside the claim transaction after the delete. Never set in the Worker. */
  afterDelete?: () => void;
}

export class MailboxStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly hooks: StoreHooks = {},
  ) {
    this.ensureSchema();
  }

  /** Idempotent. Called on every entry point because `deleteAll()` (the cleanup of an empty object) also removes the tables. */
  private ensureSchema(): void {
    const sql = this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, to_addr TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, text TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS seen (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL)');
  }

  private purge(now: number): void {
    this.ensureSchema();
    const sql = this.storage.sql;
    sql.exec('DELETE FROM messages WHERE expires_at <= ?', now);
    sql.exec('DELETE FROM seen WHERE expires_at <= ?', now);
    sql.exec('DELETE FROM nonces WHERE expires_at <= ?', now);
    sql.exec('DELETE FROM attempts WHERE at <= ?', now - RATE_WINDOW_MS);
  }

  /** Stores one message. A repeat of the same Message-ID within its lifetime is a duplicate, even after the first was consumed. */
  put(input: { to: string; runId: string; receivedAtMs: number; text: string; messageIdHash: string }, now: number): PutResult {
    return this.storage.transactionSync(() => {
      this.purge(now);
      const sql = this.storage.sql;
      if (sql.exec('SELECT 1 FROM seen WHERE id_hash = ?', input.messageIdHash).toArray().length > 0) return 'duplicate';
      const live = sql.exec('SELECT COUNT(*) AS n FROM messages WHERE expires_at > ?', now).one().n as number;
      if (live >= MAX_MESSAGES_PER_RECIPIENT) return 'full';
      sql.exec('INSERT INTO seen (id_hash, expires_at) VALUES (?, ?)', input.messageIdHash, now + SEEN_TTL_MS);
      sql.exec(
        'INSERT INTO messages (run_id, to_addr, received_at, expires_at, text) VALUES (?, ?, ?, ?, ?)',
        input.runId,
        input.to,
        input.receivedAtMs,
        Math.min(input.receivedAtMs + MESSAGE_LIFETIME_MS, now + MESSAGE_LIFETIME_MS),
        input.text,
      );
      return 'stored';
    });
  }

  /** The single-use claim: returns every live message of this run and deletes them, atomically. A repeated nonce is a replay. */
  claim(runId: string, nonce: string, now: number): ClaimResult {
    return this.storage.transactionSync((): ClaimResult => {
      this.purge(now);
      const sql = this.storage.sql;
      const recent = sql.exec('SELECT COUNT(*) AS n FROM attempts').one().n as number;
      if (recent >= MAX_CLAIMS_PER_MINUTE) return { kind: 'rate_limited' };
      sql.exec('INSERT INTO attempts (at) VALUES (?)', now);
      if (sql.exec('SELECT 1 FROM nonces WHERE nonce = ?', nonce).toArray().length > 0) return { kind: 'replay' };
      sql.exec('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)', nonce, now + NONCE_TTL_MS);
      const rows = sql
        .exec('SELECT to_addr, run_id, received_at, text FROM messages WHERE run_id = ? AND expires_at > ? ORDER BY received_at ASC, id ASC', runId, now)
        .toArray();
      sql.exec('DELETE FROM messages WHERE run_id = ?', runId);
      this.hooks.afterDelete?.();
      return {
        kind: 'claimed',
        messages: rows.map((r) => ({ to: r.to_addr as string, runId: r.run_id as string, receivedAtMs: r.received_at as number, text: r.text as string })),
      };
    });
  }

  /** Physical cleanup. Returns the next time anything needs cleaning, or null when the object holds nothing (it can then be deleted whole). */
  sweep(now: number): number | null {
    this.purge(now);
    const sql = this.storage.sql;
    const next = sql
      .exec('SELECT MIN(t) AS t FROM (SELECT MIN(expires_at) AS t FROM messages UNION ALL SELECT MIN(expires_at) FROM seen UNION ALL SELECT MIN(expires_at) FROM nonces UNION ALL SELECT MIN(at) + ? FROM attempts)', RATE_WINDOW_MS)
      .one().t as number | null;
    return next;
  }

  liveCount(now: number): number {
    this.ensureSchema();
    return this.storage.sql.exec('SELECT COUNT(*) AS n FROM messages WHERE expires_at > ?', now).one().n as number;
  }
}
