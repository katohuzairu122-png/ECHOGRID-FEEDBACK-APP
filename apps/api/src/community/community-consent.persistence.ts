import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, consentGrants, communityTermsCurrent, communityTermsPublications } from '../db/schema';
import { CommunityTermsAuthority, hashCommunityTermsContent, type CommunityTermsView } from './community-terms-authority';
import { AppError } from '../lib/errors';

export const COMMUNITY_CONSENT_ACTION = 'community_membership.consent_transition';
export const COMMUNITY_TERMS_LOCK = 'community_membership_terms_current';

/** Global currentness lock precedes customer -> account. Publisher trigger takes
 * the exclusive counterpart, so no publication can supersede acceptance in flight. */
export async function lockCommunityTerms(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${COMMUNITY_TERMS_LOCK}, 0))`);
}

export function databaseTermsAuthority(db: Db): CommunityTermsAuthority {
  return new CommunityTermsAuthority({ readCurrent: async () => {
    const [row] = await db.select({ currentPublicationId: communityTermsCurrent.publicationId, publication: communityTermsPublications.publication })
      .from(communityTermsCurrent).innerJoin(communityTermsPublications, eq(communityTermsPublications.id, communityTermsCurrent.publicationId))
      .where(eq(communityTermsCurrent.purpose, 'community_membership')).limit(1);
    return row ?? null;
  } });
}

export async function latestCommunityTransition(db: Db, membershipId: string | undefined) {
  if (!membershipId) return undefined;
  const [row] = await db.select().from(auditLog).where(and(
    eq(auditLog.entityType, 'community_membership'), eq(auditLog.entityId, membershipId), eq(auditLog.action, COMMUNITY_CONSENT_ACTION),
  )).orderBy(desc(sql`(${auditLog.metadata}->>'sequence')::bigint`)).limit(1);
  return row ? { ...row, metadata: (row.metadata ?? {}) as Record<string, unknown> } : undefined;
}

export async function communityRequestKey(customerId: string, key: string): Promise<string> {
  return `community:${await hashCommunityTermsContent(JSON.stringify([customerId, key]))}`;
}

/** Projection is revocable; immutable audit evidence must independently bind it. */
export async function validCommunityConsent(db: Db, customerId: string, membershipId: string, terms: CommunityTermsView) {
  const [grant] = await db.select().from(consentGrants).where(and(
    eq(consentGrants.customerId, customerId), eq(consentGrants.purpose, 'community_membership'),
    eq(consentGrants.resourceId, membershipId), eq(consentGrants.status, 'active'), eq(consentGrants.consentVersion, terms.version),
  )).orderBy(desc(consentGrants.grantedAt)).limit(1);
  if (!grant || grant.businessId !== null || grant.resourceType !== 'community_membership' || grant.scope !== 'community_membership' ||
    grant.metadata?.publicationId !== terms.publicationId || grant.metadata?.manifestHash !== terms.manifestHash ||
    grant.metadata?.artifactHash !== terms.contentHash || grant.metadata?.locale !== terms.locale ||
    (grant.expiresAt && grant.expiresAt.getTime() <= Date.now())) return undefined;
  if (typeof grant.metadata?.transitionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grant.metadata.transitionId)) return undefined;
  const [event] = await db.select().from(auditLog).where(and(
    eq(auditLog.id, String(grant.metadata?.transitionId ?? '00000000-0000-0000-0000-000000000000')),
    eq(auditLog.action, COMMUNITY_CONSENT_ACTION), eq(auditLog.entityId, membershipId),
  )).limit(1);
  const evidence = (event?.metadata ?? {}) as Record<string, unknown>;
  if (!event || event.actorUserId !== null || event.businessId !== null || event.entityType !== 'community_membership' || evidence.customerId !== customerId || evidence.consentGrantId !== grant.id ||
    evidence.publicationId !== terms.publicationId || evidence.manifestHash !== terms.manifestHash || evidence.version !== terms.version ||
    evidence.hashAlgorithm !== terms.hashAlgorithm || evidence.acceptedAt !== grant.grantedAt.toISOString() ||
    evidence.artifactHash !== grant.metadata?.artifactHash || evidence.locale !== grant.metadata?.locale || evidence.consentAccepted !== true || !['join', 'rejoin'].includes(String(evidence.operation))) return undefined;
  return grant;
}

export function communityConsentStale(): never {
  throw new AppError('Community terms or membership state changed. Review and retry.', 409, 'COMMUNITY_ACCEPTANCE_STALE');
}
