import Link from 'next/link';
import { resolveOptionalQrActions } from '@/lib/optional-qr-actions';
import { JoinQrMembership } from './join-qr-membership';

export async function CustomerQrActions({ token }: { token: string }) {
  const next = `/feedback/${encodeURIComponent(token)}`;
  const result = await resolveOptionalQrActions(token);
  if (!result) {
    return (
      <nav aria-label="Branch activities" className="mt-5 flex flex-wrap gap-3">
        <a href="#feedback-form" className="rounded-lg bg-brand-700 px-5 py-3 text-white">
          Leave feedback
        </a>
        <Link
          href={`/loyalty/login?next=${encodeURIComponent(next)}`}
          className="rounded-lg border px-5 py-3"
        >
          Sign in for eligible loyalty actions
        </Link>
      </nav>
    );
  }
  const actions = new Set(result.actions);
  return (
    <nav
      aria-label="Server-authorized branch activities"
      className="mt-5 flex flex-wrap items-start gap-3"
    >
      {actions.has('LEAVE_FEEDBACK') && (
        <a href="#feedback-form" className="rounded-lg bg-brand-700 px-5 py-3 text-white">
          Leave feedback
        </a>
      )}
      {actions.has('JOIN_LOYALTY') && <JoinQrMembership token={token} />}
      {actions.has('OPEN_LOYALTY_CARD') && (
        <Link
          href={`/loyalty/dashboard/${result.businessId}`}
          className="rounded-lg border px-5 py-3"
        >
          My loyalty account
        </Link>
      )}
      {actions.has('VIEW_REWARDS') && (
        <Link
          href={`/loyalty/dashboard/${result.businessId}`}
          className="rounded-lg border px-5 py-3"
        >
          View rewards
        </Link>
      )}
      {actions.has('CHECK_IN') && (
        <Link
          href={`/loyalty/${encodeURIComponent(token)}`}
          className="rounded-lg border px-5 py-3"
        >
          Check in
        </Link>
      )}
      {actions.has('SETTLE_ORPHAN_REWARD') && (
        <p className="w-full text-sm">
          You may request orphan reward settlement with this business. Settlement requires separate
          access consent, business acceptance and completion consent.
        </p>
      )}
    </nav>
  );
}
