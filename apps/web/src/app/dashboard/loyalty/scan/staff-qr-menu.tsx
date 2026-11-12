'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { QrCameraScanner } from '@/components/qr-camera-scanner';
import { staffUnifiedQrAction, type StaffQrState } from '@/lib/actions/unified-qr';
import { Button, Input, Label } from '@/components/ui';

export function StaffQrMenu({
  contexts,
}: {
  contexts: { branchId: string | null; branchName: string | null }[];
}) {
  const [state, action, pending] = useActionState(staffUnifiedQrAction, {});
  const t = useTranslations('loyalty.staff.serve');
  const formRef = useRef<HTMLFormElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  // A hardware scanner types into whichever field has focus, so the field must be ready for the next
  // customer: focused on load, and again after a finished action or an error.
  useEffect(() => {
    if (!pending && (state.success || state.error)) {
      tokenRef.current?.focus();
      tokenRef.current?.select();
    }
  }, [pending, state.success, state.error]);
  return (
    <div className="space-y-5 [&_button]:h-auto [&_button]:min-h-10 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:py-2">
      <QrCameraScanner
        large
        onDetect={(value) => {
          if (tokenRef.current) tokenRef.current.value = value;
          formRef.current?.requestSubmit();
        }}
      />
      {/* One always-ready field: a connected scanner types the customer code and presses Enter, or the cashier
          pastes it. The camera button above fills the same field. Customer lookup stays in the verified,
          business-scoped QR service flow; the general loyalty account list is an administrative destination. */}
      <div id="cashier-scan-field">
        <form ref={formRef} action={action} className="space-y-3">
          <input type="hidden" name="operation" value="resolve" />
          <Label htmlFor="token">{t('scanField')}</Label>
          <Input
            ref={tokenRef}
            id="token"
            name="token"
            defaultValue={state.token ?? ''}
            required
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby="token-hint"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p id="token-hint" className="text-sm text-neutral-600">
            {t('scanFieldHint')}
          </p>
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
          <Button disabled={pending}>Resolve permitted actions</Button>
        </form>
      </div>
      {state.error && (
        <p role="alert">
          {state.errorKind && state.errorKind !== 'other'
            ? t(`errors.${state.errorKind}`)
            : state.error}
        </p>
      )}
      {!pending && state.lookup && state.businessId && (
        <LookupMenu
          key={`${state.lookup.lookupToken}:${state.businessId}:${state.branchId}`}
          state={state}
          action={action}
          pending={pending}
        />
      )}
      {!pending && state.result && state.businessId && (
        <ResolvedMenu
          key={`${state.token}:${state.businessId}:${state.branchId}`}
          state={state}
          action={action}
          pending={pending}
        />
      )}
    </div>
  );
}

function ResolvedMenu({
  state,
  action,
  pending,
}: {
  state: StaffQrState;
  action: (form: FormData) => void;
  pending: boolean;
}) {
  const result = state.result!;
  const outcome = state;
  return (
    <div className="space-y-4 rounded-xl border bg-white p-5">
      {result.actions.includes('VIEW_ALLOWED_MEMBERSHIP_STATE') && (
        <p>Membership in this business: {result.membershipStatus}</p>
      )}
      {result.actions.length === 0 && <p>No permitted actions for this membership.</p>}
      {result.actions.includes('VALIDATE_PURCHASE') && (
        <form action={action} className="space-y-3">
          <QrContextFields state={state} />
          <h2 className="font-semibold">Validate purchase and grant loyalty progress</h2>
          <p className="text-sm">
            Confirm an actual purchase. Progress is calculated by the existing business loyalty
            policy.
          </p>
          <input type="hidden" name="operation" value="purchase" />
          <input type="hidden" name="idempotencyKey" value={state.purchaseRequestKey ?? ''} />
          <Label htmlFor="purchaseAmount">Purchase amount</Label>
          <Input
            id="purchaseAmount"
            name="purchaseAmount"
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <Button disabled={pending || state.purchaseCompleted}>Confirm verified purchase</Button>
        </form>
      )}
      {result.actions.includes('REDEEM_REWARD') && (
        <form action={action} className="space-y-3">
          <QrContextFields state={state} />
          <h2 className="font-semibold">Redeem an issued loyalty reward</h2>
          <Label htmlFor="code">Customer’s reward code</Label>
          <Input
            id="code"
            name="code"
            defaultValue={outcome.transaction?.redemptionCode ?? ''}
            required
            maxLength={8}
            autoComplete="off"
          />
          <Button name="operation" value="lookup" disabled={pending}>
            Review reward
          </Button>
          {outcome.transaction && !outcome.transaction.redemptionConfirmedAt && (
            <>
              <p>
                Issued reward code: {outcome.transaction.redemptionCode}. Loyalty points spent:{' '}
                {Math.abs(outcome.transaction.points)}.
              </p>
              <input
                type="hidden"
                name="reviewedCode"
                value={outcome.transaction.redemptionCode ?? ''}
              />
              <Button name="operation" value="confirm" disabled={pending}>
                Confirm reward handoff
              </Button>
            </>
          )}
        </form>
      )}
      {result.actions.includes('REQUEST_ORPHAN_SETTLEMENT_ACCESS') && (
        <p className="text-sm">
          Orphan settlement is a separate consented workflow. Ask the customer to explicitly
          authorize access; this scan reveals no orphan rewards.
        </p>
      )}
      {outcome.success && (
        <p role="status">Action completed. Resolve the QR again before another action.</p>
      )}
    </div>
  );
}

function QrContextFields({ state }: { state: StaffQrState }) {
  return (
    <>
      <input type="hidden" name="token" value={state.token ?? ''} />
      <input type="hidden" name="businessId" value={state.businessId ?? ''} />
      <input type="hidden" name="branchId" value={state.branchId ?? ''} />
    </>
  );
}

/**
 * A customer identified by phone lookup. Shows only a first name and a masked number (never an id), and offers
 * the purchase form only: reward redemption needs the customer's own QR code and code.
 */
function LookupMenu({
  state,
  action,
  pending,
}: {
  state: StaffQrState;
  action: (form: FormData) => void;
  pending: boolean;
}) {
  const t = useTranslations('loyalty.staff.serve.lookup');
  const lookup = state.lookup!;
  const canRecordPurchase =
    lookup.actions.includes('VALIDATE_PURCHASE') && lookup.actions.includes('GRANT_LOYALTY_PROGRESS');
  return (
    <div className="space-y-4 rounded-xl border bg-white p-5">
      <div>
        <p className="text-lg font-semibold">{lookup.displayName}</p>
        <p className="text-sm text-neutral-600">
          {lookup.phoneMasked} · {t('identified')}
        </p>
      </div>
      {canRecordPurchase ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="operation" value="lookup-purchase" />
          <input type="hidden" name="lookupToken" value={lookup.lookupToken} />
          <input type="hidden" name="businessId" value={state.businessId ?? ''} />
          <input type="hidden" name="branchId" value={state.branchId ?? ''} />
          <input type="hidden" name="idempotencyKey" value={state.purchaseRequestKey ?? ''} />
          <h2 className="font-semibold">{t('purchaseHeading')}</h2>
          <Label htmlFor="lookupPurchaseAmount">{t('amount')}</Label>
          <Input
            id="lookupPurchaseAmount"
            name="purchaseAmount"
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <Button disabled={pending || state.purchaseCompleted}>{t('confirmPurchase')}</Button>
        </form>
      ) : (
        <p className="text-sm">{t('noPurchase')}</p>
      )}
      <p className="text-sm text-neutral-600">{t('redemptionNote')}</p>
      {state.success && <p role="status">{t('done')}</p>}
    </div>
  );
}
