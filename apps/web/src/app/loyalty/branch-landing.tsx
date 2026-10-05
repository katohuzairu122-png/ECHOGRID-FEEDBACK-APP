import Link from 'next/link';
import type {
  BranchProgramDto,
  BranchMembershipDto,
  BranchLedgerDto,
  QrResolveDto,
} from '@echo-grid-feedback/shared-types';
import { hasCustomerSession } from '@/lib/customer-session';
import { customerApiFetch } from '@/lib/customer-api-client';
import { BranchPanel } from './branch-panel';
import { FeedbackForm } from '../feedback/[token]/feedback-form';

export async function BranchLanding({
  token,
  qr,
  program,
  purchaseId,
}: {
  token: string;
  qr: QrResolveDto;
  program: BranchProgramDto;
  purchaseId?: string;
}) {
  const signedIn = await hasCustomerSession();
  const accounts = signedIn
    ? await customerApiFetch<BranchMembershipDto[]>(
        '/branch-loyalty/me/memberships',
        {},
        `/loyalty/${token}`,
      )
    : [];
  const membership = accounts.find((a) => a.branchId === program.branchId);
  const history = membership
    ? await customerApiFetch<BranchLedgerDto[]>(
        `/branch-loyalty/me/memberships/${membership.id}/history`,
      )
    : [];
  const purchases = history.filter((entry) => entry.type === 'purchase');
  return (
    <>
      <BranchPanel
        token={token}
        branchName={qr.branchName}
        businessName={qr.businessName}
        program={program}
        signedIn={signedIn}
        {...(membership ? { membership } : {})}
      />
      {purchaseId ? (
        <FeedbackForm
          token={token}
          branchName={qr.branchName}
          businessName={qr.businessName}
          submissionKey={crypto.randomUUID()}
          purchaseId={purchaseId}
          feedbackForm={qr.feedbackForm ?? null}
        />
      ) : (
        <section className="mx-auto max-w-md space-y-3 p-6">
          <h2 className="text-lg font-semibold">Feedback with purchase evidence</h2>
          {purchases.length ? (
            purchases.map((purchase) => (
              <Link
                className="block underline"
                key={purchase.id}
                href={`/feedback/${token}?purchase=${purchase.id}`}
              >
                Give feedback for receipt {purchase.receiptReference}
              </Link>
            ))
          ) : (
            <p>
              After staff confirm your purchase, return to this QR page to give verified feedback.
            </p>
          )}
          <Link className="block underline" href={`/feedback/${token}?survey=1`}>
            Continue as a survey participant without a purchase
          </Link>
          <p className="text-sm">
            Survey points and partner redemption will open once the partner program is configured.
            No survey points are being issued yet.
          </p>
        </section>
      )}
    </>
  );
}
