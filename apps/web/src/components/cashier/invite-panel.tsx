'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import QRCode from 'react-qr-code';
import { cashierIssueInviteAction, type CashierInviteState } from '@/lib/cashier/actions';
import { Button } from '@/components/ui';

export interface InvitePanelCopy {
  intro: string;
  create: string;
  creating: string;
  another: string;
  qrLabel: string;
  scanHint: string;
  validFor: string; // contains {time}
  expiredTitle: string;
  expiredBody: string;
  copy: string;
  copied: string;
  copyFailed: string;
  rateLimited: string;
  branchRequired: string;
  unavailable: string;
}

/**
 * CASHIER-AUTH-02D: the counter screen that creates a one-time onboarding invitation. The customer scans the code with their own phone and
 * joins under their own account and consent; the cashier never enters or sees any customer detail. The screen is drawn for ONE branch: it is
 * keyed by branch in the page, so a branch switch discards the invitation, and the action is bound to that branch.
 */
export function InvitePanel({ expectedBranchId, branchName, copy }: { expectedBranchId: string | null; branchName: string | null; copy: InvitePanelCopy }) {
  const [pending, startTransition] = useTransition();
  const [invite, setInvite] = useState<Extract<CashierInviteState, { status: 'ready' }> | null>(null);
  const [problem, setProblem] = useState<'rate_limited' | 'branch_required' | 'unavailable' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (!invite) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invite]);

  const create = useCallback(() => {
    setProblem(null);
    setCopyState('idle');
    startTransition(async () => {
      try {
        const result = await cashierIssueInviteAction(expectedBranchId);
        if (result.status === 'ready') {
          setInvite(result);
          setNow(Date.now());
          return;
        }
        setInvite(null);
        setProblem(result.status);
      } catch {
        setInvite(null);
        setProblem('unavailable');
      }
    });
  }, [expectedBranchId]);

  const remainingMs = invite ? new Date(invite.expiresAt).getTime() - now : 0;
  const expired = invite !== null && remainingMs <= 0;
  const minutes = Math.max(0, Math.floor(remainingMs / 60000));
  const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
  const time = `${minutes}:${String(seconds).padStart(2, '0')}`;

  async function copyLink() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600">{copy.intro}</p>
      {branchName && <p className="text-xs text-neutral-500">{branchName}</p>}

      {invite && !expired && (
        <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 text-center">
          <div role="img" aria-label={copy.qrLabel} className="mx-auto w-fit rounded bg-white p-3">
            <QRCode value={invite.inviteUrl} size={224} />
          </div>
          <p className="text-sm text-neutral-700">{copy.scanHint}</p>
          <p role="timer" className="text-sm font-semibold tabular-nums text-brand-700">{copy.validFor.replace('{time}', time)}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button type="button" variant="outline" className="min-h-12" onClick={copyLink}>{copyState === 'copied' ? copy.copied : copy.copy}</Button>
          </div>
          {copyState === 'failed' && <p role="alert" className="text-sm text-red-700">{copy.copyFailed}</p>}
        </div>
      )}

      {expired && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold">{copy.expiredTitle}</p>
          <p>{copy.expiredBody}</p>
        </div>
      )}

      {problem === 'rate_limited' && <p role="alert" className="text-sm text-red-700">{copy.rateLimited}</p>}
      {problem === 'branch_required' && <p role="alert" className="text-sm text-red-700">{copy.branchRequired}</p>}
      {problem === 'unavailable' && <p role="alert" className="text-sm text-red-700">{copy.unavailable}</p>}

      <Button type="button" size="lg" className="min-h-12 w-full" disabled={pending} onClick={create}>
        {pending ? copy.creating : invite ? copy.another : copy.create}
      </Button>
    </div>
  );
}
