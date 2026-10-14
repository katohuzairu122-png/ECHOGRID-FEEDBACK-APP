'use client';
import { useActionState, useState } from 'react';
import { customerSettlementReviewAction } from '@/lib/actions/settlements';
import type { SettlementView } from '@/lib/settlement-types';
import { Button } from '@/components/ui';

export function SettlementReviewForm({ initial }: { initial: SettlementView }) {
  const [state, action, pending] = useActionState(
    customerSettlementReviewAction.bind(null, initial.id),
    {},
  );
  const [requestKey] = useState(() => crypto.randomUUID());
  const current = state.review ?? initial;
  const canComplete = current.status === 'reserved' && !!current.fulfillmentSnapshot;
  const canCancel = ['proposed', 'accepted', 'reserved', 'completion_authorized'].includes(
    current.status,
  );
  return (
    <form action={action} className="space-y-4 rounded-xl border bg-white p-5">
      <p>Status: {current.status}</p>
      <p>Receiving business: {current.receivingBusinessId}</p>
      <p>Reservation expires: {current.expiresAt}</p>
      {current.fulfillmentSnapshot && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{current.fulfillmentSnapshot.title}</h2>
          <p>Benefit: {current.fulfillmentSnapshot.benefitType}</p>
          <p>{current.fulfillmentSnapshot.description}</p>
          <p>{current.fulfillmentSnapshot.terms}</p>
          <p>
            Policy: {current.fulfillmentPolicyVersion}. Reference:{' '}
            {current.fulfillmentReference ?? 'None'}.
          </p>
        </div>
      )}
      <input type="hidden" name="requestKey" value={requestKey} />
      <input
        type="hidden"
        name="reviewedContract"
        value={JSON.stringify({
          policy: current.fulfillmentPolicyVersion,
          reference: current.fulfillmentReference,
          snapshot: current.fulfillmentSnapshot,
        })}
      />
      {canComplete && (
        <>
          <label className="flex gap-2">
            <input type="checkbox" name="consent" />I have reviewed this exact benefit and authorize
            this receiving business to fulfill this orphan reward settlement.
          </label>
          <Button name="operation" value="complete" disabled={pending}>
            Authorize completion
          </Button>
        </>
      )}
      {current.status === 'proposed' && <p>Awaiting independent receiving-business acceptance.</p>}
      {current.status === 'completion_authorized' && (
        <p>
          Your short-lived completion authorization is recorded. The receiving business must fulfill
          it before it expires.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button name="operation" value="refresh" variant="outline" disabled={pending}>
          Refresh authoritative status
        </Button>
        {canCancel && (
          <Button name="operation" value="cancel" variant="outline" disabled={pending}>
            Cancel settlement request
          </Button>
        )}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {state.success && (
        <p role="status">Request processed. Status above reflects the server response.</p>
      )}
    </form>
  );
}
