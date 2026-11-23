'use client';

import { useActionState, useEffect, useState } from 'react';
import type { CommunityTermsOffer } from '@echo-grid-feedback/shared-types';
import { CommunityEnrollmentControls } from './enrollment-controls';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui';
import { leaveCommunityAction, type CommunityLeaveState } from '@/lib/actions/community-membership';
import type { CommunityPhoneEligibility } from '@/lib/community-membership';
import styles from './membership-controls.module.css';

const initial: CommunityLeaveState = {};

export function CommunityMembershipControls({ status, phone, offer = null }: {
  status: 'absent' | 'active' | 'left' | 'suspended' | 'inactive'; phone: CommunityPhoneEligibility; offer?: CommunityTermsOffer | null;
}) {
  const t = useTranslations('loyalty.customer.community.selfService');
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [state, action, pending] = useActionState(leaveCommunityAction, initial);
  const router = useRouter();
  const offerKey = offer ? `${offer.terms.publicationId}:${offer.terms.locale}:${offer.transitionId ?? 'first'}:${offer.activationAvailable === true}` : 'unavailable';
  useEffect(() => {
    if (state.left) { setOpen(false); setConfirmed(false); router.refresh(); }
  }, [state.left, router]);

  return <div className={styles.controls} data-testid="community-membership-controls">
    <p>{t('distinction')}</p>
    {status === 'inactive' && <><p role="status">{t('inactive')}</p><CommunityEnrollmentControls key={offerKey} restore rejoin phone={phone} offer={offer} /></>}
    {status === 'suspended' ? <p role="status">{t('suspended')}</p> : (status === 'active' || status === 'inactive') ? <>
      <button className={styles.action} type="button" onClick={() => { setConfirmed(false); setOpen(true); }}>{t('leave')}</button>
      <Dialog open={open} onOpenChange={(value) => { if (!pending) { setOpen(value); setConfirmed(false); } }}>
        <DialogContent className={styles.dialog ?? ''}>
          <DialogTitle>{t('confirmTitle')}</DialogTitle>
          <DialogDescription>{t('confirmBody')}</DialogDescription>
          <form action={action} className={styles.controls}>
            <label className={styles.confirmation}>
              <input type="checkbox" name="confirmed" value="yes" required checked={confirmed}
                disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} />{t('confirmLabel')}
            </label>
            {state.error && <p role="alert">{t(`errors.${state.error}`)}</p>}
            <div className={styles.actions}>
              <button className={styles.action} type="button" disabled={pending} onClick={() => setOpen(false)}>{t('cancel')}</button>
              <button className={styles.action} type="submit" disabled={pending || !confirmed}>{t(pending ? 'leaving' : 'confirmLeave')}</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </> : <CommunityEnrollmentControls key={offerKey} rejoin={status === 'left'} phone={phone} offer={offer} />}
    {state.left && <p role="status">{t('left')}</p>}
    <p>{t('feedRule')}</p>
  </div>;
}
