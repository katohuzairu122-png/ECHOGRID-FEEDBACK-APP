import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CommunityTermsAuthority,
  hashCommunityTermsContent,
  hashCommunityTermsManifest,
  validateCommunityTermsAcceptance,
} from '../community/community-terms-authority';

// Synthetic approval ONLY. No fixture is exported, persisted or served.
async function fixture() {
  const id = randomUUID();
  const artifacts = await Promise.all((['en', 'fr', 'es', 'ar'] as const).map(async (locale) => {
    const content = `SYNTHETIC TEST ARTIFACT — NOT LEGAL TERMS — ${locale}\r\n`;
    return { locale, content, contentHash: await hashCommunityTermsContent(content) };
  }));
  const publication = {
    id, purpose: 'community_membership' as const, version: 'synthetic-test-only',
    approval: { status: 'approved', reference: 'synthetic-not-owner-approval', approvedAt: '2020-01-01T00:00:00Z' },
    publishedAt: '2020-01-02T00:00:00Z', effectiveAt: '2020-01-03T00:00:00Z',
    artifacts, manifestHash: '',
  };
  publication.manifestHash = await hashCommunityTermsManifest(publication);
  return { currentPublicationId: id, publication };
}
async function acceptance() {
  const snapshot = await fixture();
  const terms = await new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en');
  return { terms, request: {
    operation: 'join', consentAccepted: true,
    expectedPublicationId: terms.publicationId, expectedTermsVersion: terms.version,
    expectedTermsHash: terms.manifestHash, expectedArtifactHash: terms.contentHash,
    displayedLocale: 'en', expectedTransitionId: null, idempotencyKey: 'synthetic-request',
  } };
}
const unavailable = { status: 503, code: 'COMMUNITY_TERMS_UNAVAILABLE', message: 'Community membership terms are unavailable.' };
const basis = { operation: 'join' as const, transitionId: null };

describe('NETWORK-15-T2 independent terms foundation (NOT activation enforcement)', () => {
  it('ships an empty authority that cannot resolve approved terms', async () => {
    await expect(new CommunityTermsAuthority().resolve('en')).rejects.toMatchObject(unavailable);
  });
  it.each([null, undefined, {}, [], 'approved'])('fails closed on missing/malformed source %j', async (value) => {
    await expect(new CommunityTermsAuthority({ readCurrent: async () => value }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('does not expose source failures, SQL, credentials or schema details', async () => {
    const authority = new CommunityTermsAuthority({ readCurrent: async () => { throw new Error('secret-token missing relation'); } });
    await expect(authority.resolve('en')).rejects.toMatchObject(unavailable);
  });
  it.each(['draft', 'superseded'])('denies %s publications', async (status) => {
    const snapshot = await fixture(); snapshot.publication.approval.status = status;
    await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it.each(['reference', 'approvedAt'])('denies missing approval %s', async (key) => {
    const snapshot = await fixture(); const publication = { ...snapshot.publication, approval: { ...snapshot.publication.approval, [key]: null } };
    await expect(new CommunityTermsAuthority({ readCurrent: async () => ({ ...snapshot, publication }) }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it.each(['publishedAt', 'effectiveAt'])('denies absent or future %s', async (key) => {
    for (const value of [null, '2099-01-01T00:00:00Z', 'not-a-date']) {
      const snapshot = await fixture(); const publication = { ...snapshot.publication, [key]: value };
      await expect(new CommunityTermsAuthority({ readCurrent: async () => ({ ...snapshot, publication }) }).resolve('en')).rejects.toMatchObject(unavailable);
    }
  });
  it('denies future or post-publication approval', async () => {
    for (const approvedAt of ['2099-01-01T00:00:00Z', '2020-01-04T00:00:00Z']) {
      const snapshot = await fixture(); snapshot.publication.approval.approvedAt = approvedAt;
      await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
    }
  });
  it('denies a version that is not the server current-pointer target', async () => {
    const snapshot = await fixture(); snapshot.currentPublicationId = randomUUID();
    await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('checks exact UTF-8 bytes, including CRLF and Arabic text', async () => {
    expect(await hashCommunityTermsContent('شروط\r\n')).not.toBe(await hashCommunityTermsContent('شروط\n'));
    expect(await hashCommunityTermsContent('é')).not.toBe(await hashCommunityTermsContent('e\u0301'));
    const snapshot = await fixture(); snapshot.publication.artifacts[0]!.content += '\n';
    await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('checks every artifact even when the requested translation is intact', async () => {
    const snapshot = await fixture(); snapshot.publication.artifacts[3]!.content = 'tampered';
    await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('denies altered manifest bindings and duplicate locales', async () => {
    const snapshot = await fixture(); snapshot.publication.manifestHash = '0'.repeat(64);
    await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
    const duplicate = await fixture(); duplicate.publication.artifacts[3] = duplicate.publication.artifacts[0]!;
    duplicate.publication.manifestHash = await hashCommunityTermsManifest(duplicate.publication);
    await expect(new CommunityTermsAuthority({ readCurrent: async () => duplicate }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('binds the manifest deterministically independent of source artifact order', async () => {
    const snapshot = await fixture();
    expect(await hashCommunityTermsManifest({ ...snapshot.publication, artifacts: [...snapshot.publication.artifacts].reverse() }))
      .toBe(snapshot.publication.manifestHash);
    expect(await hashCommunityTermsManifest({ ...snapshot.publication, version: 'other-version' })).not.toBe(snapshot.publication.manifestHash);
  });
  it('does not silently fall back from absent or unsupported translations', async () => {
    const snapshot = await fixture(); snapshot.publication.artifacts = snapshot.publication.artifacts.filter((item) => item.locale !== 'ar');
    snapshot.publication.manifestHash = await hashCommunityTermsManifest(snapshot.publication);
    for (const locale of ['ar', 'de', '../../en'])
      await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve(locale)).rejects.toMatchObject(unavailable);
  });
  it.each(['en', 'fr', 'es', 'ar'])('returns a closed immutable %s view without approval metadata', async (locale) => {
    const snapshot = await fixture();
    const terms = await new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve(locale);
    expect(Object.keys(terms).sort()).toEqual(['publicationId', 'version', 'effectiveAt', 'locale', 'content', 'contentHash', 'manifestHash', 'hashAlgorithm'].sort());
    expect(terms.locale).toBe(locale); expect(Object.isFrozen(terms)).toBe(true);
    snapshot.publication.artifacts.find((item) => item.locale === locale)!.content = 'later mutation';
    expect(terms.content).not.toBe('later mutation');
  });
  it('rejects unexpected registry fields rather than returning sensitive metadata', async () => {
    const snapshot = await fixture();
    await expect(new CommunityTermsAuthority({ readCurrent: async () => ({ ...snapshot, token: 'private' }) }).resolve('en')).rejects.toMatchObject(unavailable);
  });
  it('bounds artifact text and rejects empty artifacts', async () => {
    for (const content of ['', 'x'.repeat(100_001)]) {
      const snapshot = await fixture(); snapshot.publication.artifacts[0]!.content = content;
      snapshot.publication.artifacts[0]!.contentHash = await hashCommunityTermsContent(content);
      snapshot.publication.manifestHash = await hashCommunityTermsManifest(snapshot.publication);
      await expect(new CommunityTermsAuthority({ readCurrent: async () => snapshot }).resolve('en')).rejects.toMatchObject(unavailable);
    }
  });
  it('validates an explicit exact binding without creating evidence or membership', async () => {
    const { request, terms } = await acceptance();
    expect(validateCommunityTermsAcceptance(request, terms, basis)).toEqual(request);
    expect(Object.isFrozen(validateCommunityTermsAcceptance(request, terms, basis))).toBe(true);
  });
  it.each([undefined, false, 'true', 1, null])('denies non-explicit consent %j', async (consentAccepted) => {
    const { request, terms } = await acceptance();
    expect(() => validateCommunityTermsAcceptance({ ...request, consentAccepted }, terms, basis)).toThrow('Explicit current terms acceptance is required.');
  });
  it.each(['customerId', 'businessId', 'verified', 'acceptedAt', 'approval', 'auditId', 'grantId', 'policyVersion'])('denies client authority field %s', async (key) => {
    const { request, terms } = await acceptance();
    expect(() => validateCommunityTermsAcceptance({ ...request, [key]: 'forged' }, terms, basis)).toThrow('Explicit current terms acceptance is required.');
  });
  it.each(['expectedPublicationId', 'expectedTermsVersion', 'expectedTermsHash', 'expectedArtifactHash', 'displayedLocale', 'expectedTransitionId', 'operation'])('denies stale %s', async (key) => {
    const { request, terms } = await acceptance();
    const value = key.endsWith('Id') ? randomUUID() : key.endsWith('Hash') ? '0'.repeat(64) : key === 'displayedLocale' ? 'fr' : key === 'operation' ? 'rejoin' : 'unknown';
    expect(() => validateCommunityTermsAcceptance({ ...request, [key]: value }, terms, basis))
      .toThrow('Community terms or membership state changed. Review and retry.');
  });
  it.each(['', ' ', ' leading', 'trailing ', 'x'.repeat(101)])('rejects invalid request key %j', async (idempotencyKey) => {
    const { request, terms } = await acceptance();
    expect(() => validateCommunityTermsAcceptance({ ...request, idempotencyKey }, terms, basis)).toThrow('Explicit current terms acceptance is required.');
  });
  it('requires a fresh server lifecycle basis for Rejoin', async () => {
    const { request, terms } = await acceptance(); const transitionId = randomUUID();
    const rejoin = { ...request, operation: 'rejoin', expectedTransitionId: transitionId };
    expect(validateCommunityTermsAcceptance(rejoin, terms, { operation: 'rejoin', transitionId })).toEqual(rejoin);
    expect(() => validateCommunityTermsAcceptance(rejoin, terms, { operation: 'rejoin', transitionId: randomUUID() })).toThrow('Community terms or membership state changed. Review and retry.');
  });
  it('ships an empty registry without the unapproved legal candidate', () => {
    const migration = readFileSync(resolve('drizzle/0088_community_membership_consent.sql'), 'utf8');
    expect(migration).toContain("VALUES ('community_membership', NULL)");
    expect(migration).not.toContain('community-membership-v1.0');
    expect(migration).not.toMatch(/INSERT INTO public\.community_terms_publications/i);
  });
});
