'use client';
import QRCode from 'react-qr-code';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export function CustomerQrDisplay({ token, expiresAt }: { token: string; expiresAt: string }) {
  const [expired, setExpired] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return (
    <div className="space-y-4">
      {expired ? (
        <p role="status">QR expired. Generate a fresh QR.</p>
      ) : (
        <>
          <div className="w-fit max-w-full bg-white p-4">
            <QRCode value={token} size={220} title="Short-lived customer identity" />
          </div>
          <details>
            <summary>Token for staff-assisted entry</summary>
            <p className="break-all text-xs">{token}</p>
          </details>
          <p>
            Expires: <time dateTime={expiresAt}>{expiresAt}</time>
          </p>
        </>
      )}
      <Button onClick={() => router.refresh()}>Generate fresh QR</Button>
    </div>
  );
}
