import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { networkFollows } from '../db/schema/network-posts';
import { AppError } from '../lib/errors';

/** A generous per-customer bound so follows can never be used to store unbounded data. */
export const NETWORK_MAX_FOLLOWS = 200;

export type FollowedBusinessDto = { businessHandle: string; businessName: string | null };

const notFound = () => new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');

/**
 * BCOMM-04 voluntary follows (NETWORK-00 section 6). A follow is a customer-owned bookmark of a PUBLISHED business: it is not a loyalty
 * membership, Community membership, consent, notification or marketing permission, and creates no ledger, balance or message. The customer id
 * always comes from the session. An unknown, unpublished, suspended or inactive business is the same generic not-found.
 */
export class NetworkFollowService {
  constructor(private readonly db: Database) {}

  private async publishedBusinessId(profileHandle: string): Promise<string> {
    const rows = await this.db.execute(sql`
      select p.business_id from business_public_profiles p join businesses b on b.id = p.business_id
       where p.profile_handle = ${profileHandle} and p.publication_state = 'published' and b.status = 'active'`);
    const row = (rows.rows as { business_id: string }[])[0];
    if (!row) throw notFound();
    return row.business_id;
  }

  /** Idempotent. */
  async follow(customerId: string, profileHandle: string): Promise<{ following: true }> {
    const businessId = await this.publishedBusinessId(profileHandle);
    await this.db.transaction(async (tx) => {
      // Serialise per customer so two parallel requests cannot both pass the bound.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'network-follow:' + customerId}, 0))`);
      const [existing] = await tx.select({ id: networkFollows.businessId }).from(networkFollows)
        .where(and(eq(networkFollows.customerId, customerId), eq(networkFollows.businessId, businessId)));
      if (existing) return;
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(networkFollows)
        .where(eq(networkFollows.customerId, customerId)) as [{ n: number }];
      if (n >= NETWORK_MAX_FOLLOWS) throw new AppError('You are following the maximum number of businesses.', 409, 'NETWORK_FOLLOW_LIMIT');
      await tx.insert(networkFollows).values({ customerId, businessId });
    });
    return { following: true };
  }

  /** Idempotent. Allowed even if the business has since been unpublished (the customer can always remove their own follow). */
  async unfollow(customerId: string, profileHandle: string): Promise<{ following: false }> {
    const rows = await this.db.execute(sql`select business_id from business_public_profiles where profile_handle = ${profileHandle}`);
    const row = (rows.rows as { business_id: string }[])[0];
    if (!row) throw notFound();
    await this.db.delete(networkFollows).where(and(eq(networkFollows.customerId, customerId), eq(networkFollows.businessId, row.business_id)));
    return { following: false };
  }

  /** The customer's OWN follows of currently visible businesses. Never another customer's, never counts of others. */
  async list(customerId: string): Promise<FollowedBusinessDto[]> {
    const rows = await this.db.execute(sql`
      select pr.profile_handle as business_handle, coalesce(t.display_name, td.display_name) as business_name
        from network_follows f
        join business_public_profiles pr on pr.business_id = f.business_id
        join businesses b on b.id = f.business_id
        left join business_profile_revision_translations t on t.revision_id = pr.published_revision_id and t.locale = b.default_locale
        left join business_profile_revision_translations td on td.revision_id = pr.published_revision_id and td.locale = 'en'
       where f.customer_id = ${customerId}::uuid and pr.publication_state = 'published' and b.status = 'active'
       order by f.created_at desc, f.business_id
       limit ${NETWORK_MAX_FOLLOWS}`);
    return (rows.rows as { business_handle: string; business_name: string | null }[])
      .map((r) => ({ businessHandle: r.business_handle, businessName: r.business_name }));
  }
}
