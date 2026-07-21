'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import QRCode from 'react-qr-code';
import { useTranslations } from 'next-intl';
import type { QrCodeDto } from '@echo-grid-feedback/shared-types';
import { getQrCodeAction, regenerateQrCodeAction } from '@/lib/actions/qr-codes';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui';

interface QrCodeDialogProps {
  branchId: string;
  branchName: string;
  /** See BranchFormDialog's identical prop -- Base UI's Trigger clones this element. */
  trigger: React.ReactElement<Record<string, unknown>>;
}

/**
 * Fetches on open rather than receiving QR data as a prop from the branches
 * list -- GET /branches/:id/qr-code lazily CREATES a code on first call
 * (QR Engagement Block 2), so eagerly fetching for every branch on list-page
 * load would auto-create a code for branches nobody has asked about yet.
 * Re-fetches every time the dialog re-opens (cheap, low-frequency
 * interaction) rather than trusting stale local state, in case the code was
 * regenerated from another tab/session.
 *
 * The scannable URL is built from window.location.origin, not a new env
 * var: the dashboard and the public /feedback/[token] page (Block 3) are
 * the SAME Next.js deployment, so wherever this page is being served from
 * is, by definition, the correct host for the customer-facing URL too.
 */
export function QrCodeDialog({ branchId, branchName, trigger }: QrCodeDialogProps) {
  const [open, setOpen] = useState(false);
  const [qrCode, setQrCode] = useState<QrCodeDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const svgContainerRef = useRef<HTMLDivElement>(null);
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('branches.qr');

  useEffect(() => {
    if (!open) return;
    setError(null);
    startTransition(async () => {
      try {
        setQrCode(await getQrCodeAction(branchId));
      } catch {
        setError(t('loadError'));
      }
    });
  }, [open, branchId, startTransition, t]);

  const feedbackUrl =
    qrCode && typeof window !== 'undefined' ? `${window.location.origin}/feedback/${qrCode.token}` : '';

  const handleRegenerate = () => {
    const confirmed = confirm(t('regenerateConfirm'));
    if (!confirmed) return;

    startTransition(async () => {
      try {
        setQrCode(await regenerateQrCodeAction(branchId));
      } catch {
        setError(t('regenerateError'));
      }
    });
  };

  /** SVG (not PNG/canvas) matches react-qr-code's native output and is the
   * better format for what businesses actually do with this -- print it. */
  const handleDownload = () => {
    const svg = svgContainerRef.current?.querySelector('svg');
    if (!svg) return;

    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${branchName.replace(/\s+/g, '-').toLowerCase()}-qr-code.svg`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{branchName}</DialogDescription>

        <div className="mt-4 flex flex-col items-center gap-4">
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          {!qrCode && !error && <p className="py-12 text-sm text-neutral-500">{t('loading')}</p>}

          {qrCode && (
            <>
              <div ref={svgContainerRef} className="rounded-lg border border-neutral-200 p-4">
                <QRCode value={feedbackUrl} size={192} />
              </div>
              <p className="break-all text-center text-xs text-neutral-500">{feedbackUrl}</p>
              <div className="flex w-full justify-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleDownload}>
                  {t('downloadButton')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={pending}
                >
                  {pending ? t('working') : t('regenerateButton')}
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <DialogClose render={<Button type="button" variant="ghost" />}>{t('close')}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
