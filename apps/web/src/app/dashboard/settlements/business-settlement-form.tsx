'use client';
import { useActionState } from 'react';
import { businessSettlementAction } from '@/lib/actions/settlements';
import { Button, Input, Label, Select } from '@/components/ui';

// Agreement box: the existing required consent checkbox, presented as a clear, tappable panel.
const AGREEMENT_BOX =
  'flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-300 p-4 text-sm leading-relaxed';
const AGREEMENT_CHECKBOX = 'mt-0.5 size-5 shrink-0 accent-brand-600';

export function BusinessSettlementForm({
  contexts,
}: {
  contexts: { branchId: string | null; branchName: string | null }[];
}) {
  const [state, action, pending] = useActionState(businessSettlementAction, {});
  const allowed = new Set(state.allowedActions ?? []);
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-5 rounded-xl border bg-white p-5">
        <div className="space-y-2">
          <Label htmlFor="branchId">Authorized business or branch</Label>
          <Select
            id="branchId"
            name="branchId"
            defaultValue={state.branchId ?? contexts[0]?.branchId ?? ''}
          >
            {contexts.map((context) => (
              <option key={context.branchId ?? 'business'} value={context.branchId ?? ''}>
                {context.branchName ?? 'Business-wide access'}
              </option>
            ))}
          </Select>
          <Button name="operation" value="list" variant="secondary" disabled={pending}>
            Load authorized settlement queue
          </Button>
        </div>
        <div className="space-y-2">
          <Label htmlFor="settlementId">Customer-provided settlement reference</Label>
          <Input
            id="settlementId"
            name="settlementId"
            defaultValue={state.inspected?.settlementId ?? ''}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="authorizationId">Customer-provided access authorization reference</Label>
          <Input
            id="authorizationId"
            name="authorizationId"
            defaultValue={state.accessAuthorizationId ?? ''}
            autoComplete="off"
          />
        </div>
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
              <div className="space-y-2">
                <Label htmlFor="benefitType">Concrete benefit to fulfill</Label>
                <Select id="benefitType" name="benefitType">
                  <option value="discount">Discount</option>
                  <option value="free_item">Free item</option>
                  <option value="voucher">Voucher</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="title">Benefit title</Label>
                <Input id="title" name="title" maxLength={120} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Benefit description</Label>
                <textarea
                  id="description"
                  name="description"
                  maxLength={1000}
                  required
                  className="w-full rounded border p-3"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="terms">Benefit terms</Label>
                <textarea
                  id="terms"
                  name="terms"
                  maxLength={2000}
                  className="w-full rounded border p-3"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reference">Fulfillment reference (optional)</Label>
                <Input id="reference" name="reference" maxLength={200} />
              </div>
              <label className={AGREEMENT_BOX}>
                <input type="checkbox" name="consent" required className={AGREEMENT_CHECKBOX} />
                <span>
                  I independently accept this settlement and commit this business to the benefit
                  described above.
                </span>
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
                  <label className={AGREEMENT_BOX}>
                    <input type="checkbox" name="consent" required className={AGREEMENT_CHECKBOX} />
                    <span>I confirm actual fulfillment of the customer-reviewed benefit.</span>
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
