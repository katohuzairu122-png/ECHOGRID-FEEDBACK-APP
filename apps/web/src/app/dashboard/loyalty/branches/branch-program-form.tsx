'use client';
import { useActionState } from 'react';
import type { BranchProgramDto } from '@echo-grid-feedback/shared-types';
import { branchStaffAction } from '@/lib/actions/branch-loyalty';
import { Button } from '@/components/ui';
const inputClass = 'block w-full rounded border border-neutral-300 p-2';
export function BranchProgramForm({
  branchId,
  program,
}: {
  branchId: string;
  program: BranchProgramDto | null;
}) {
  const [state, action, pending] = useActionState(
    branchStaffAction.bind(null, 'program', branchId),
    {},
  );
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        Onboarding mode
        <select
          name="onboardingMode"
          className={inputClass}
          defaultValue={program?.onboardingMode ?? 'community'}
        >
          <option value="community">Echo Grid community</option>
          <option value="business_only">Business only, with optional community enrollment</option>
        </select>
      </label>
      <label className="block">
        Qualifying purchase rules
        <textarea
          name="qualifyingPurchaseDescription"
          required
          maxLength={1000}
          defaultValue={program?.qualifyingPurchaseDescription}
          className={inputClass}
          placeholder="Which paid products qualify and how staff count them"
        />
      </label>
      <label className="block">
        Progress unit
        <input
          name="unitLabel"
          required
          maxLength={100}
          defaultValue={program?.unitLabel}
          className={inputClass}
          placeholder="For example, stamps or points"
        />
      </label>
      <label className="block">
        Reward
        <input
          name="rewardName"
          required
          maxLength={200}
          defaultValue={program?.rewardName}
          className={inputClass}
          placeholder="For example, one free coffee"
        />
      </label>
      <label className="block">
        Units required
        <input
          name="rewardCost"
          type="number"
          min={1}
          max={1000000}
          required
          defaultValue={program?.rewardCost}
          className={inputClass}
        />
      </label>
      <label className="block">
        Extra units for verified purchase feedback
        <input
          name="feedbackBonusUnits"
          type="number"
          min={0}
          max={1000000}
          required
          defaultValue={program?.feedbackBonusUnits ?? 0}
          className={inputClass}
        />
      </label>
      <p className="text-sm">
        Awarded once per purchase for any rating. Zero means no additional bonus.
      </p>
      <label className="block">
        <input
          name="listedInCommunity"
          type="checkbox"
          defaultChecked={program?.listedInCommunity}
        />{' '}
        Publish this branch as a member business
      </label>
      <label className="block">
        <input name="enabled" type="checkbox" defaultChecked={program?.enabled} /> Enable enrollment
        and purchase rewards
      </label>
      <p className="text-sm">
        Customers join first; staff confirm the paid purchase and qualifying units. QR scans earn no
        purchase rewards. Existing balances stay separate. No default expiry is added.
      </p>
      <Button disabled={pending}>Save branch program</Button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && <p role="status">{state.message}</p>}
    </form>
  );
}
export function BranchStaffTransactionForm({
  branchId,
  operation,
}: {
  branchId: string;
  operation: 'purchase' | 'refund' | 'confirm';
}) {
  const [state, action, pending] = useActionState(
    branchStaffAction.bind(null, operation, branchId),
    {},
  );
  return (
    <form action={action} className="space-y-3">
      {operation === 'purchase' ? (
        <>
          <label className="block">
            Customer membership ID
            <input
              name="membershipId"
              required
              className={inputClass}
              placeholder="Scan or paste the customer’s branch membership QR"
            />
          </label>
          <label className="block">
            Receipt reference
            <input name="receiptReference" required maxLength={100} className={inputClass} />
          </label>
          <label className="block">
            Qualifying units
            <input
              name="qualifyingUnits"
              required
              type="number"
              min={1}
              max={1000000}
              className={inputClass}
            />
          </label>
          <label className="block">
            Evidence of paid qualifying purchase
            <textarea
              name="evidence"
              required
              maxLength={1000}
              className={inputClass}
              placeholder="Product and paid receipt confirmation; do not enter card details"
            />
          </label>
          <p>I confirm this customer made the qualifying paid purchase at this branch.</p>
        </>
      ) : operation === 'refund' ? (
        <>
          <label className="block">
            Purchase transaction ID
            <input name="purchaseId" required className={inputClass} />
          </label>
          <label className="block">
            Refund reason
            <textarea name="reason" required maxLength={1000} className={inputClass} />
          </label>
          <p>
            The matching reward units will be reversed. Spent or reserved rewards require review.
          </p>
        </>
      ) : (
        <>
          <label className="block">
            Customer redemption code
            <input name="code" required className={inputClass} />
          </label>
          <p>Confirm only after giving the customer the reward at this branch.</p>
        </>
      )}
      <Button disabled={pending}>
        {operation === 'purchase'
          ? 'Confirm paid purchase'
          : operation === 'refund'
            ? 'Reverse purchase rewards'
            : 'Confirm reward supplied'}
      </Button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && (
        <p role="status" className="break-all">
          {state.message}
        </p>
      )}
    </form>
  );
}
