'use client';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { customerSettlementAccessAction } from '@/lib/actions/settlements';
import { Button, Input, Label } from '@/components/ui';

export function SettlementAccessForm({
  claimId,
  initialQrToken = '',
}: {
  claimId: string;
  initialQrToken?: string;
}) {
  const [state, action, pending] = useActionState(
    customerSettlementAccessAction.bind(null, claimId),
    {},
  );
  const [requestKey] = useState(() => crypto.randomUUID());
  return (
    <form action={action} className="space-y-3">
      <Label htmlFor={`qr-${claimId}`}>Receiving business’s existing QR token</Label>
      <Input
        id={`qr-${claimId}`}
        name="businessQrToken"
        defaultValue={state.businessQrToken ?? initialQrToken}
        autoComplete="off"
        required
      />
      <input type="hidden" name="requestKey" value={requestKey} />
      <Button name="operation" value="preview" disabled={pending || !!state.access}>
        Review receiving business
      </Button>
      {state.qr && !state.access && (
        <div className="space-y-3">
          <p>
            Receiving business: {state.qr.businessName} · {state.qr.branchName}
          </p>
          <input type="hidden" name="reviewedBusinessId" value={state.qr.businessId} />
          <label className="flex gap-2">
            <input type="checkbox" name="consent" />I authorize this business to view this claim’s
            minimal settlement information for this request. This does not authorize fulfillment.
          </label>
          <Button name="operation" value="authorize" disabled={pending}>
            Authorize settlement access
          </Button>
        </div>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {state.access && (
        <div role="status" className="space-y-2 break-all">
          <p>
            Access authorized until {state.access.authorization.expiresAt}. Share these two request
            references privately with the receiving business:
          </p>
          <p>
            Settlement: <code>{state.access.settlement.id}</code>
          </p>
          <p>
            Access authorization: <code>{state.access.authorization.id}</code>
          </p>
          <Link
            href={`/loyalty/dashboard/settlements/${state.access.settlement.id}`}
            className="underline"
          >
            Review benefit and completion consent
          </Link>
          <p>
            Keep the review link. The business must accept before you can authorize completion.
            Cancel from the review page to revoke this pending workflow.
          </p>
        </div>
      )}
    </form>
  );
}
