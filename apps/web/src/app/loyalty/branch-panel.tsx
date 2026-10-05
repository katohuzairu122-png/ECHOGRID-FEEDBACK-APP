'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import QRCode from 'react-qr-code';
import type { BranchProgramDto, BranchMembershipDto } from '@echo-grid-feedback/shared-types';
import { branchCustomerAction } from '@/lib/actions/branch-loyalty';
import { Button } from '@/components/ui';

export function MembershipQr({ id }: { id: string }) {
  return (
    <div className="space-y-2 rounded-lg bg-white p-4">
      <QRCode value={id} size={160} />
      <p className="break-all text-sm">Membership: {id}</p>
      <p className="text-sm">Show this QR to branch staff when you buy a qualifying product.</p>
    </div>
  );
}
export function BranchPanel({
  token,
  businessName,
  branchName,
  program,
  signedIn,
  membership,
}: {
  token: string;
  businessName: string;
  branchName: string;
  program: BranchProgramDto;
  signedIn: boolean;
  membership?: BranchMembershipDto;
}) {
  const [state, action, pending] = useActionState(
    branchCustomerAction.bind(null, 'join', token),
    {},
  );
  const id = membership?.id ?? state.membershipId;
  return (
    <section className="mx-auto my-8 max-w-md space-y-5 rounded-xl border bg-white p-6">
      <h1 className="text-2xl font-semibold">
        {businessName} · {branchName}
      </h1>
      <p>{program.qualifyingPurchaseDescription}</p>
      <p>
        Earn {program.unitLabel} at this branch. {program.rewardCost} unlocks {program.rewardName},
        redeemable here.
      </p>
      {program.feedbackBonusUnits > 0 && (
        <p>
          Give verified feedback after your purchase to earn {program.feedbackBonusUnits} extra{' '}
          {program.unitLabel}, once per purchase and for any rating.
        </p>
      )}
      {!program.enabled ? (
        <p>
          This branch has paused new loyalty activity. Your existing rewards remain in your account.
        </p>
      ) : id ? (
        <>
          <MembershipQr id={id} />
          <p>
            {membership?.activatedAt
              ? 'Active branch membership'
              : 'Awaiting your first qualifying purchase'}
          </p>
          <Link className="underline" href="/loyalty/dashboard/branches">
            My branch rewards
          </Link>
        </>
      ) : !signedIn ? (
        <Link
          className="block rounded bg-brand-700 p-3 text-center text-white"
          href={`/loyalty/login?next=${encodeURIComponent(`/loyalty/${token}`)}`}
        >
          Sign in or create an account with your phone
        </Link>
      ) : (
        <form action={action} className="space-y-4">
          <label className="flex gap-2">
            <input
              type="checkbox"
              name="joinCommunity"
              required={program.onboardingMode === 'community'}
            />
            <span>
              Join the Echo Grid community to discover member businesses.{' '}
              {program.onboardingMode === 'business_only'
                ? 'Optional: leave unchecked to stay with this business only.'
                : 'This program uses Echo Grid community enrollment.'}{' '}
              Your phone is used for your account; joining does not share it with other businesses.
            </span>
          </label>
          <Button disabled={pending}>Start enrollment</Button>
        </form>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && <p role="status">{state.message}</p>}
      <p className="text-sm">
        Scanning a QR code does not award purchase rewards. Staff confirm your qualifying paid
        purchase. Honest feedback of any rating is welcome.
      </p>
    </section>
  );
}
export function RedeemBranchForm({
  id,
  requestId,
  disabled,
}: {
  id: string;
  requestId: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(
    branchCustomerAction.bind(null, 'redeem', id),
    {},
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="requestId" value={requestId} />
      <Button disabled={disabled || pending}>Redeem at this branch</Button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.code && <p className="break-all">Redemption code: {state.code}</p>}
      {state.message && <p role="status">{state.message}</p>}
    </form>
  );
}
export function CommunityChoiceForm({ joined }: { joined: boolean }) {
  const [state, action, pending] = useActionState(
    branchCustomerAction.bind(null, 'community', ''),
    {},
  );
  return (
    <form action={action} className="space-y-2">
      <label>
        <input name="joined" type="checkbox" defaultChecked={joined} /> Join the Echo Grid community
      </label>
      <p>Your branch memberships and earned rewards remain when you change this preference.</p>
      <Button disabled={pending}>Save preference</Button>
      {state.message && <p role="status">{state.message}</p>}
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
