'use client';
import QRCode from 'react-qr-code';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import {
  refreshCustomerQrAction,
  revokeCustomerQrAction,
  type CustomerQrCredential,
} from '@/lib/actions/loyalty-customer';
import { isQrExpired, msUntilRotation, QR_ROTATE_RETRY_MS } from '@/lib/customer-qr-rotation';

/**
 * Renewable customer identity QR (CUSTOMER-QR-ROTATION-01). Valid up to 24 hours and renewed automatically before it
 * expires, including when the tab returns to the foreground. A successful transaction never invalidates it. The
 * "Replace QR" action revokes every earlier code server-side and shows a fresh one.
 */
export function CustomerQrDisplay({ token, expiresAt }: CustomerQrCredential) {
  const [qr, setQr] = useState<CustomerQrCredential>({ token, expiresAt });
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(async (action: () => Promise<CustomerQrCredential>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setQr(await action());
      setError(null);
    } catch {
      setError('Could not renew your QR. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const wait = msUntilRotation(qr.expiresAt, Date.now());
    const timer = setTimeout(() => void run(refreshCustomerQrAction), wait === 0 ? QR_ROTATE_RETRY_MS : wait);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && msUntilRotation(qr.expiresAt, Date.now()) === 0) {
        void run(refreshCustomerQrAction);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    onVisible();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [qr.expiresAt, run]);

  const expired = isQrExpired(qr.expiresAt, now);
  return (
    <div className="space-y-4">
      {expired ? (
        <p role="status">{busy ? 'Renewing your QR…' : 'Your QR expired. Renew it to continue.'}</p>
      ) : (
        <>
          <div data-keep-light="" className="w-fit max-w-full bg-white p-4">
            <QRCode value={qr.token} size={220} title="Customer identity" />
          </div>
          <details>
            <summary>Token for staff-assisted entry</summary>
            <p className="break-all text-xs">{qr.token}</p>
          </details>
          <p>
            Valid until: <time dateTime={qr.expiresAt}>{qr.expiresAt}</time> (renews automatically)
          </p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={() => void run(refreshCustomerQrAction)}>
          Renew QR
        </Button>
        <Button disabled={busy} onClick={() => void run(revokeCustomerQrAction)}>
          Replace QR (revoke old codes)
        </Button>
      </div>
    </div>
  );
}
