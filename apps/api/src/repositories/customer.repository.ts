import { eq, and, sql, desc, lte, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { customers, customerCredentials, customerSanctions, businessCustomerMemberships } from '../db/schema';
import { isUniqueViolation } from '../lib/pg-errors';
import { BaseRepository } from './base.repository';

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

/**
 * No businessId on any method here -- customers are a GLOBAL identity (see
 * schema comment on customers.ts), unlike every business-owned repository
 * elsewhere in this codebase. Tenant scoping for loyalty data lives on
 * LoyaltyAccountRepository instead.
 */
export class CustomerRepository extends BaseRepository {
  async findById(id: string): Promise<Customer | undefined> {
    const row = await this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.isDeleted, false)),
    });
    return row ? this.liftIfSuspensionEnded(row) : row;
  }

  async findByIdForUpdate(id: string): Promise<Customer | undefined> {
    const [row] = await this.db.select().from(customers)
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false))).for('update');
    return row ? this.liftIfSuspensionEnded(row) : row;
  }

  /** Atomically moves the customer's QR revocation epoch forward; every earlier QR token stops resolving. */
  async bumpQrRevocationEpoch(id: string): Promise<number | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ qrRevocationEpoch: sql`${customers.qrRevocationEpoch} + 1` })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning({ epoch: customers.qrRevocationEpoch });
    return row?.epoch;
  }

  /**
   * The VERIFIED owner of a phone number (at most one exists: partial unique index). This is the only phone lookup
   * that may identify a customer for authentication or recovery: an unverified number is a claim, not ownership.
   */
  async findVerifiedByPhone(phone: string): Promise<Customer | undefined> {
    const row = await this.db.query.customers.findFirst({
      where: and(eq(customers.phone, phone), isNotNull(customers.phoneVerifiedAt), eq(customers.isDeleted, false)),
    });
    return row ? this.liftIfSuspensionEnded(row) : row;
  }

  /** Every non-deleted customer holding the number, verified or not, verified first. Never an authentication input. */
  async listByPhone(phone: string): Promise<Customer[]> {
    const rows = await this.db.query.customers.findMany({
      where: and(eq(customers.phone, phone), eq(customers.isDeleted, false)),
    });
    const lifted = await Promise.all(rows.map((row) => this.liftIfSuspensionEnded(row)));
    return lifted.sort((x, y) => Number(Boolean(y.phoneVerifiedAt)) - Number(Boolean(x.phoneVerifiedAt)));
  }

  /**
   * A timed suspension ends by itself. Every access check in the API compares
   * `status === 'active'`, so rather than touching each of them, the two
   * lookups they all go through reinstate a customer whose suspension period
   * has passed. Only suspended rows with an end time ever write; the common
   * active path costs nothing extra. The reinstatement is recorded in the
   * sanctions history (no actor) so it is visible.
   */
  private async liftIfSuspensionEnded(row: Customer, now: Date = new Date()): Promise<Customer> {
    if (row.status !== 'suspended' || !row.suspendedUntil || row.suspendedUntil.getTime() > now.getTime()) {
      return row;
    }
    const [lifted] = await this.db
      .update(customers)
      .set({ status: 'active', suspendedUntil: null })
      .where(
        and(
          eq(customers.id, row.id),
          eq(customers.status, 'suspended'),
          lte(customers.suspendedUntil, now),
        ),
      )
      .returning();
    if (lifted) {
      await this.db.insert(customerSanctions).values({
        customerId: row.id,
        action: 'lift',
        reason: 'Suspension period ended.',
      });
      return lifted;
    }
    return (await this.db.query.customers.findFirst({ where: eq(customers.id, row.id) })) ?? row;
  }

  /**
   * Platform moderation list. Exact lookup only: a customer id or a full
   * phone number typed by the admin; there is no free-text browse of names or
   * contact details. Returns a membership count per row, never loyalty data.
   */
  async listForPlatform(input: {
    id?: string | undefined;
    phone?: string | undefined;
    status?: 'active' | 'limited' | 'suspended' | 'banned' | undefined;
    withoutBusiness?: boolean | undefined;
    limit: number;
    offset: number;
  }): Promise<Array<Customer & { businessCount: number }>> {
    const businessCount = sql<number>`(SELECT count(*)::int FROM ${businessCustomerMemberships} m WHERE m.customer_id = ${customers.id} AND m.is_deleted = false)`;
    const conditions = [eq(customers.isDeleted, false)];
    if (input.id) conditions.push(eq(customers.id, input.id));
    if (input.phone) conditions.push(eq(customers.phone, input.phone));
    if (input.status === 'limited') {
      conditions.push(eq(customers.status, 'active'), gt(customers.limitedUntil, new Date()));
    } else if (input.status) {
      conditions.push(eq(customers.status, input.status));
    }
    if (input.withoutBusiness) conditions.push(sql`${businessCount} = 0`);
    const rows = await this.db
      .select({ customer: customers, businessCount })
      .from(customers)
      .where(and(...conditions))
      .orderBy(desc(customers.createdAt))
      .limit(input.limit)
      .offset(input.offset);
    return rows.map((r) => ({ ...r.customer, businessCount: r.businessCount }));
  }

  async countBusinesses(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(businessCustomerMemberships)
      .where(and(eq(businessCustomerMemberships.customerId, customerId), eq(businessCustomerMemberships.isDeleted, false)));
    return row?.n ?? 0;
  }

  async setModeration(
    id: string,
    patch: { status: 'active' | 'suspended' | 'banned'; suspendedUntil: Date | null; limitedUntil: Date | null },
  ): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ status: patch.status, suspendedUntil: patch.suspendedUntil, limitedUntil: patch.limitedUntil })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
  }

  async create(input: NewCustomer): Promise<Customer> {
    const [row] = await this.db.insert(customers).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Find-or-create keyed on the VERIFIED owner of a phone, safe under concurrency. The caller has just proven the
   * phone (OTP). The insert is `ON CONFLICT DO NOTHING` against the partial unique index, then the winner is re-read.
   *
   * A conflict with NO visible row means the number is held verified by a soft-deleted customer: returned as
   * `customer: undefined` so the caller can refuse cleanly.
   *
   * Unverified rows holding the same number are NOT the owner. The one exception, so existing customers are never
   * locked out: a legacy PHONE-ONLY account (no login credentials of its own) that is the only unverified holder is
   * claimed and marked verified. A row that has its own credentials (an email customer who merely typed the number)
   * is never handed to the person who proved the phone; they get their own verified account instead. Whenever a
   * verified owner results, the remaining unverified claims on that number are released.
   */
  async createIfAbsent(input: {
    phone: string;
    phoneVerifiedAt: Date;
  }): Promise<{ customer: Customer | undefined; created: boolean }> {
    const verified = await this.findVerifiedByPhone(input.phone);
    if (verified) return { customer: verified, created: false };

    const legacy = await this.soleLegacyPhoneOnlyHolder(input.phone);
    if (legacy) {
      const claimed = await this.markPhoneVerified(legacy.id);
      if (claimed) {
        await this.releaseUnverifiedClaims(input.phone, claimed.id);
        return { customer: claimed, created: false };
      }
    }

    const inserted = await this.db
      .insert(customers)
      .values({ phone: input.phone, phoneVerifiedAt: input.phoneVerifiedAt })
      .onConflictDoNothing({ target: customers.phone, where: isNotNull(customers.phoneVerifiedAt) })
      .returning();
    if (inserted[0]) {
      await this.releaseUnverifiedClaims(input.phone, inserted[0].id);
      return { customer: inserted[0], created: true };
    }
    const winner = await this.findVerifiedByPhone(input.phone);
    return { customer: winner, created: false };
  }

  /**
   * An OTP-to-email upgrade is for EXISTING phone-only identities, not new signups.
   * A phone proof may establish ownership, but it must never create a new customer
   * through this restricted bridge. A uniquely held old phone-only claim can be
   * verified in place; an email identity that merely typed the phone is not eligible.
   */
  async resolveExistingPhoneForCredentialUpgrade(phone: string): Promise<Customer | undefined> {
    const verified = await this.findVerifiedByPhone(phone);
    if (verified) return verified;

    const legacy = await this.soleLegacyPhoneOnlyHolder(phone);
    if (!legacy) return undefined;
    let claimed: Customer | undefined;
    try {
      // The match remains bound to this exact number and unverified state at
      // UPDATE time. The partial verified-phone unique index arbitrates races.
      const [row] = await this.db.update(customers).set({
        phoneVerifiedAt: new Date(), updatedAt: new Date(),
      }).where(and(
        eq(customers.id, legacy.id), eq(customers.phone, phone),
        isNull(customers.phoneVerifiedAt), eq(customers.isDeleted, false),
      )).returning();
      claimed = row;
    } catch (error) {
      // Only the verified-phone unique index represents a competing ownership
      // claim here. Do not hide connection, permission, timeout or schema
      // failures as an identity miss; the global boundary sanitizes those.
      if (isUniqueViolation(error, ['customers_phone_verified_unique'])) return undefined;
      throw error;
    }
    if (!claimed) return undefined;

    // Keep post-claim cleanup outside the uniqueness catch: an operational
    // failure after the claim must be visible and retried/handled, not
    // misreported as a denied identity upgrade.
    await this.releaseUnverifiedClaims(phone, claimed.id);
    return claimed;
  }

  /** The only non-deleted UNVERIFIED holder of the number that has no credentials of its own, if exactly one. */
  private async soleLegacyPhoneOnlyHolder(phone: string): Promise<Customer | undefined> {
    const rows = await this.db
      .select({ id: customers.id })
      .from(customers)
      .leftJoin(customerCredentials, eq(customerCredentials.customerId, customers.id))
      .where(and(
        eq(customers.phone, phone),
        isNull(customers.phoneVerifiedAt),
        eq(customers.isDeleted, false),
        isNull(customerCredentials.customerId),
      ));
    if (rows.length !== 1) return undefined;
    return this.db.query.customers.findFirst({ where: eq(customers.id, rows[0]!.id) });
  }

  /** A verified owner now exists: the number is cleared from every OTHER unverified row that merely claimed it. */
  async releaseUnverifiedClaims(phone: string, verifiedOwnerId: string): Promise<void> {
    await this.db
      .update(customers)
      .set({ phone: null, updatedAt: new Date() })
      .where(and(eq(customers.phone, phone), isNull(customers.phoneVerifiedAt), ne(customers.id, verifiedOwnerId)));
  }

  /**
   * An authenticated customer has proven ownership of `phone` (OTP): they become its verified owner, unless another
   * customer already holds it verified ('taken'). First to verify owns the number; stale unverified claims are released.
   */
  async claimVerifiedPhone(
    customerId: string,
    phone: string,
  ): Promise<{ ok: true; customer: Customer } | { ok: false; reason: 'taken' | 'not_found' }> {
    const holder = await this.findVerifiedByPhone(phone);
    if (holder && holder.id !== customerId) return { ok: false, reason: 'taken' };
    try {
      const [row] = await this.db
        .update(customers)
        .set({ phone, phoneVerifiedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(customers.id, customerId), eq(customers.isDeleted, false)))
        .returning();
      if (!row) return { ok: false, reason: 'not_found' };
      await this.releaseUnverifiedClaims(phone, customerId);
      return { ok: true, customer: row };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });
      if (cause.code === '23505') return { ok: false, reason: 'taken' };
      throw error;
    }
  }

  async markPhoneVerified(id: string): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ phoneVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return row;
  }

  /** PROF-01: the customer's own display name, bio and avatar key. A key set to null clears it; an undefined key is left alone. */
  async setGlobalProfile(
    id: string,
    patch: { displayName?: string | null | undefined; bio?: string | null | undefined; avatarKey?: string | null | undefined },
  ): Promise<Customer | undefined> {
    const set: Partial<NewCustomer> = { updatedAt: new Date() };
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.avatarKey !== undefined) set.avatarKey = patch.avatarKey;
    const [row] = await this.db
      .update(customers)
      .set(set)
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
  }

  async updateProfile(
    id: string,
    patch: Partial<Pick<NewCustomer, 'fullName' | 'email' | 'birthday'>>,
  ): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
  }

  async setPreferredLocale(id: string, locale: string): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ preferredLocale: locale, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
  }
}
