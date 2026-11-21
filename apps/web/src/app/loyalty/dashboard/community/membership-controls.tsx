'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui';
import { leaveCommunityAction, type CommunityLeaveState } from '@/lib/actions/community-membership';
import type { CommunityPhoneEligibility } from '@/lib/community-membership';
import styles from './membership-controls.module.css';

const initial: CommunityLeaveState = {};
const RETURN = '/loyalty/dashboard/community';

export function CommunityMembershipControls({ status, phone }: {
  status: 'absent' | 'active' | 'left' | 'suspended'; phone: CommunityPhoneEligibility;
}) {
  const t = useTranslations('loyalty.customer.community.selfService');
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [state, action, pending] = useActionState(leaveCommunityAction, initial);
  const router = useRouter();
  useEffect(() => {
    if (state.left) { setOpen(false); setConfirmed(false); router.refresh(); }
  }, [state.left, router]);

  return <div className={styles.controls} data-testid="community-membership-controls">
    <p>{t('distinction')}</p>
    {status === 'suspended' ? <p role="status">{t('suspended')}</p> : status === 'active' ? <>
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
    </> : <>
      <p role="status">{t('termsUnavailable')}</p>
      <button className={styles.action} type="button" disabled aria-describedby="community-terms-note">{t(status === 'left' ? 'rejoin' : 'join')}</button>
      <p id="community-terms-note">{t('termsRequired')}</p>
      {phone === 'unverified' ? <>
        <p>{t('phoneRequired')}</p>
        <Link className={styles.action} href={`/loyalty/dashboard/phone?next=${encodeURIComponent(RETURN)}`}>{t('verifyPhone')}</Link>
        <Link className={styles.action} href="/loyalty/dashboard/settings">{t('settings')}</Link>
      </> : phone === 'unavailable' ? <><p role="status">{t('phoneUnavailable')}</p><button className={styles.action} type="button" onClick={() => router.refresh()}>{t('retry')}</button></> : <p>{t('phoneVerified')}</p>}
    </>}
    {state.left && <p role="status">{t('left')}</p>}
    <p>{t('feedRule')}</p>
  </div>;
}
