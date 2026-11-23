'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { CommunityTermsOffer } from '@echo-grid-feedback/shared-types';
import type { CommunityPhoneEligibility } from '@/lib/community-membership';
import { joinCommunityAction, type CommunityJoinState } from '@/lib/actions/community-membership';
import styles from './membership-controls.module.css';

const initial: CommunityJoinState = {};
export function CommunityEnrollmentControls({ rejoin, restore = false, phone, offer }: { rejoin: boolean; restore?: boolean; phone: CommunityPhoneEligibility; offer: CommunityTermsOffer | null }) {
  const t = useTranslations('loyalty.customer.community.selfService'); const router = useRouter();
  const [accepted, setAccepted] = useState(false); const [key, setKey] = useState('');
  const [state, action, pending] = useActionState(joinCommunityAction, initial);
  useEffect(() => { setKey(crypto.randomUUID()); setAccepted(false); }, [offer?.terms.publicationId, offer?.transitionId]);
  useEffect(() => { if (state.joined) router.refresh(); }, [state.joined, router]);
  return <div className={styles.controls}>
    {offer && offer.activationAvailable === true ? <form action={action} className={styles.controls}>
      <h3>{t('termsTitle')}</h3>
      <p>{t('termsVersion', { version: offer.terms.version, date: offer.terms.effectiveAt })}</p>
      <div className={styles.terms} tabIndex={0} role="region" aria-label={t('termsTitle')}>{offer.terms.content}</div>
      {Object.entries({ operation: offer.operation, expectedPublicationId: offer.terms.publicationId, expectedTermsVersion: offer.terms.version,
        expectedTermsHash: offer.terms.manifestHash, expectedArtifactHash: offer.terms.contentHash, displayedLocale: offer.terms.locale,
        expectedTransitionId: offer.transitionId ?? '', idempotencyKey: key }).map(([name,value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <label className={styles.confirmation}><input type="checkbox" name="consentAccepted" value="yes" required checked={accepted}
        disabled={pending || phone !== 'verified'} onChange={(e) => setAccepted(e.target.checked)} />{t('acceptTerms')}</label>
      <button className={styles.action} type="submit" disabled={!accepted || !key || pending || state.joined || state.error === 'stale' || phone !== 'verified'}>{t(pending ? restore ? 'restoring' : 'joining' : restore ? 'restore' : rejoin ? 'rejoin' : 'join')}</button>
      {state.error && <><p role="alert">{t(`joinErrors.${state.error}`)}</p>{state.error === 'phone' && <Link className={styles.action} href="/loyalty/dashboard/phone?next=%2Floyalty%2Fdashboard%2Fcommunity">{t('verifyPhone')}</Link>}<button className={styles.action} type="button" onClick={() => { setAccepted(false); router.refresh(); }}>{t('retry')}</button></>}
      {state.joined && <p role="status">{t(restore ? 'restored' : 'joined', { count: state.released ?? 0 })}</p>}
    </form> : <><p role="status">{t(offer ? 'operationUnavailable' : 'termsUnavailable')}</p><button className={styles.action} type="button" disabled aria-describedby="community-terms-note">{t(restore ? 'restore' : rejoin ? 'rejoin' : 'join')}</button><button className={styles.action} type="button" onClick={() => router.refresh()}>{t('retry')}</button></>}
    <p id="community-terms-note">{t('termsRequired')}</p>
    {phone === 'unverified' ? <><p>{t('phoneRequired')}</p>
      <Link className={styles.action} href="/loyalty/dashboard/phone?next=%2Floyalty%2Fdashboard%2Fcommunity">{t('verifyPhone')}</Link>
      <Link className={styles.action} href="/loyalty/dashboard/settings">{t('settings')}</Link></>
      : phone === 'unavailable' ? <><p role="status">{t('phoneUnavailable')}</p><button className={styles.action} type="button" onClick={() => router.refresh()}>{t('retry')}</button></> : <p>{t('phoneVerified')}</p>}
  </div>;
}
