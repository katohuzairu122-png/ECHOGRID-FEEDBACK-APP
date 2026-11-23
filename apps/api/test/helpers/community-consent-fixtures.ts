import type { Db } from '../../src/db/client';
/** TEST ONLY: synthetic approvals on loopback disposable PostgreSQL. */
import { Client } from 'pg';
import { CommunityMembershipService as RuntimeService } from '../../src/community/community-membership.service';
import { hashCommunityTermsContent, hashCommunityTermsManifest } from '../../src/community/community-terms-authority';

export async function publishSyntheticCommunityTerms(version = 'synthetic-community-consent') {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Synthetic approvals require a loopback disposable database.');
  const client = new Client({ connectionString: url }); await client.connect();
  try {
    const existing = await client.query('select publication from community_terms_publications where version=$1', [version]);
    let publication = existing.rows[0]?.publication;
    if (!publication) {
      const artifacts = await Promise.all((['en', 'fr', 'es', 'ar'] as const).map(async (locale) => {
        const content = `SYNTHETIC TEST TERMS ONLY — NO LEGAL APPROVAL — ${locale}`;
        return { locale, content, contentHash: await hashCommunityTermsContent(content) };
      }));
      publication = { id: crypto.randomUUID(), purpose: 'community_membership', version,
        approval: { status: 'approved', reference: 'synthetic-fixture-only', approvedAt: '2020-01-01T00:00:00Z' },
        publishedAt: '2020-01-02T00:00:00Z', effectiveAt: '2020-01-03T00:00:00Z', artifacts, manifestHash: '' };
      publication.manifestHash = await hashCommunityTermsManifest(publication);
      const result = await client.query('insert into community_terms_publications(id,version,publication) values($1,$2,$3) on conflict(version) do nothing returning publication', [publication.id, version, publication]);
      publication = result.rows[0]?.publication ?? (await client.query('select publication from community_terms_publications where version=$1', [version])).rows[0].publication;
    }
    await client.query("update community_terms_current set publication_id=$1 where purpose='community_membership'", [publication.id]);
    return publication;
  } finally { await client.end(); }
}

/** Isolated test opt-in only. Never exported from application code. */
export const SYNTHETIC_MEMBERSHIP_CONTROLS = Object.freeze({
  COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true',
  COMMUNITY_MEMBERSHIP_REJOIN_ENABLED: 'true',
  COMMUNITY_MEMBERSHIP_RESTORE_ENABLED: 'true',
  COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED: 'true',
});

const attempts = new Map<string, { request: Record<string, unknown>; transitionId: string }>();

export async function syntheticCommunityAcceptance(service: RuntimeService, customerId: string, label = 'synthetic-community-http') {
  await publishSyntheticCommunityTerms(label);
  const offer = await service.getOffer(customerId, 'en'); if (!offer) throw new Error('Synthetic offer missing');
  return { operation: offer.operation, consentAccepted: true, expectedPublicationId: offer.terms.publicationId,
    expectedTermsVersion: offer.terms.version, expectedTermsHash: offer.terms.manifestHash, expectedArtifactHash: offer.terms.contentHash,
    displayedLocale: 'en', expectedTransitionId: offer.transitionId, idempotencyKey: crypto.randomUUID() };
}

/** Fixture driver, not a stand-in service: every transition invokes the actual
 * runtime implementation, real terms adapter, grant/audit writes and locks.
 * Old test labels are converted to explicit synthetic acceptance ONLY here.
 */
export class FixtureCommunityMembershipService extends RuntimeService {
  constructor(db: Db) { super(db, SYNTHETIC_MEMBERSHIP_CONTROLS); }
  override async join(customerId: string, label: unknown) {
    if (typeof label !== 'string') return super.join(customerId, label);
    const state = await this.getStatus(customerId);
    if (state.membership?.status === 'suspended' || state.account?.status === 'suspended') return super.join(customerId, {});
    const publication = await publishSyntheticCommunityTerms(label);
    const offer = await this.getOffer(customerId, 'en');
    if (!offer) throw new Error('Synthetic terms offer missing');
    const cached = attempts.get(customerId);
    const request = cached?.transitionId === offer.transitionId && cached.request.expectedPublicationId === publication.id ? cached.request : {
      operation: offer.operation, consentAccepted: true, expectedPublicationId: offer.terms.publicationId,
      expectedTermsVersion: offer.terms.version, expectedTermsHash: offer.terms.manifestHash,
      expectedArtifactHash: offer.terms.contentHash, displayedLocale: 'en', expectedTransitionId: offer.transitionId,
      idempotencyKey: crypto.randomUUID(),
    };
    const result = await super.join(customerId, request);
    attempts.set(customerId, { request, transitionId: result.consent.transitionId });
    return result;
  }
}
