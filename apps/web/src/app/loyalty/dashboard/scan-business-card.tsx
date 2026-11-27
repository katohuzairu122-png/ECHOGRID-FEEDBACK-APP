'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { QrCameraScanner } from '@/components/qr-camera-scanner';
import { businessQrTarget } from '@/lib/business-qr-target';

/**
 * Customer account: scan a business's QR code with the device camera without leaving the app, then continue on the same
 * page the printed code opens (where the customer can join that business). A scan only navigates; it never joins, grants
 * points or redeems anything by itself. Text that is not a business QR code is refused and nothing is opened.
 */
export function ScanBusinessCard() {
  const t = useTranslations('loyalty.customer.scanBusiness');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState(false);

  function handleDetect(value: string) {
    const target = businessQrTarget(value);
    if (!target) {
      setRejected(true);
      return;
    }
    setRejected(false);
    router.push(target);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {open ? (
          <QrCameraScanner onDetect={handleDetect} namespace="loyalty.customer.scanBusiness" />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-5 py-2.5 font-medium text-white hover:bg-brand-800"
          >
            {t('start')}
          </button>
        )}
        {rejected ? (
          <p role="alert" className="text-sm text-danger">
            {t('notBusinessQr')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
