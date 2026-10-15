'use client';
import { useActionState } from 'react';
import { businessSettlementAction } from '@/lib/actions/settlements';
import { Button, Input, Label } from '@/components/ui';

export function BusinessSettlementForm({
  contexts,
}: {
  contexts: { branchId: string | null; branchName: string | null }[];
}) {
  const [state, action, pending] = useActionState(businessSettlementAction, {});
  const allowed = new Set(state.allowedActions ?? []);
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-3 rounded-xl border bg-white p-5">
        <Label htmlFor="branchId">Authorized business or branch</Label>
        <select
          id="branchId"
          name="branchId"
          defaultValue={state.branchId ?? contexts[0]?.branchId ?? ''}
          className="w-full rounded border p-3"
        >
          {contexts.map((context) => (
            <option key={context.branchId ?? 'business'} value={context.branchId ?? ''}>
              {context.branchName ?? 'Business-wide access'}
            </option>
          ))}
        </select>
        <Button name="operation" value="list" disabled={pending}>
          Load authorized settlement queue
        </Button>
        <Label htmlFor="settlementId">Customer-provided settlement reference</Label>
        <Input
          id="settlementId"
          name="settlementId"
          defaultValue={state.inspected?.settlementId ?? ''}
          autoComplete="off"
        />
        <Label htmlFor="authorizationId">Customer-provided access authorization reference</Label>
        <Input
          id="authorizationId"
          name="authorizationId"
          defaultValue={state.accessAuthorizationId ?? ''}
          autoComplete="off"
        />
        <Button name="operation" value="inspect" disabled={pending}>
          Inspect consented reward information
        </Button>
      </form>
      {!pending && state.inspected && (
        <form action={action} className="space-y-3 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">
            {state.inspected.claim.reward.name ?? state.inspected.claim.sourceRewardType}
          </h2>
          <p>{state.inspected.claim.reward.description}</p>
          <p>Access expires: {state.inspected.authorizationExpiresAt}</p>
          <input type="hidden" name="settlementId" value={state.inspected.settlementId} />
          <input type="hidden" name="reviewedBusinessId" value={state.businessId} />
          <input type="hidden" name="branchId" value={state.branchId ?? ''} />
          {allowed.has('settlement:accept') && (
            <>
              <input
                type="hidden"
                name="authorizationId"
                value={state.accessAuthorizationId ?? ''}
              />
              <Label htmlFor="benefitType">Concrete benefit to fulfill</Label>
              <select id="benefitType" name="benefitType" className="w-full rounded border p-3">
                <option value="discount">Discount</option>
                <option value="free_item">Free item</option>
                <option value="voucher">Voucher</option>
              </select>
              <Label htmlFor="title">Benefit title</Label>
              <Input id="title" name="title" maxLength={120} required />
              <Label htmlFor="description">Benefit description</Label>
              <textarea
                id="description"
                name="description"
                maxLength={1000}
                required
                className="w-full rounded border p-3"
              />
              <Label htmlFor="terms">Benefit terms</Label>
              <textarea
                id="terms"
                name="terms"
                maxLength={2000}
                className="w-full rounded border p-3"
              />
              <Label htmlFor="reference">Fulfillment reference (optional)</Label>
              <Input id="reference" name="reference" maxLength={200} />
              <label className="flex gap-2">
                <input type="checkbox" name="consent" required />I independently accept this
                settlement and commit this business to the benefit described above.
              </label>
              <Button name="operation" value="accept" disabled={pending}>
                Accept and reserve orphan reward
              </Button>
            </>
          )}
        </form>
      )}
      {!pending &&
        state.settlements?.map((settlement) => (
          <article key={settlement.id} className="space-y-3 rounded-xl border bg-white p-5">
            <h2 className="break-all font-semibold">Settlement {settlement.id}</h2>
            <p>Status: {settlement.status}</p>
            {settlement.receivingBranchId && (
              <p>
                Receiving branch:{' '}
                {contexts.find((context) => context.branchId === settlement.receivingBranchId)
                  ?.branchName ?? 'Select the receiving branch to fulfill this request.'}
              </p>
            )}
            <p>Expires: {settlement.expiresAt}</p>
            <h3 className="font-semibold">{settlement.fulfillmentSnapshot?.title}</h3>
            <p>{settlement.fulfillmentSnapshot?.description}</p>
            <p>{settlement.fulfillmentSnapshot?.terms}</p>
            <p>
              Policy: {settlement.fulfillmentPolicyVersion}. Reference:{' '}
              {settlement.fulfillmentReference ?? 'None'}.
            </p>
            {settlement.status === 'completion_authorized' &&
              allowed.has('settlement:fulfill') &&
              settlement.receivingBranchId === (state.branchId ?? null) && (
                <form action={action} className="space-y-3">
                  <input type="hidden" name="settlementId" value={settlement.id} />
                  <input type="hidden" name="reviewedBusinessId" value={state.businessId} />
                  <input type="hidden" name="branchId" value={state.branchId ?? ''} />
                  <label className="flex gap-2">
                    <input type="checkbox" name="consent" required />I confirm actual fulfillment of
                    the customer-reviewed benefit.
                  </label>
                  <Button name="operation" value="fulfill" disabled={pending}>
                    Confirm orphan settlement fulfillment
                  </Button>
                </form>
              )}
          </article>
        ))}
      {state.error && <p role="alert">{state.error}</p>}
      {state.success && (
        <p role="status">Settlement action recorded. No financial credit was issued.</p>
      )}
    </div>
  );
}
