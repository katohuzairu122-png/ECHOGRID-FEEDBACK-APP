import type { Metadata } from 'next';
import { LEGAL_CONTACT_EMAIL, LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Refund and Cancellation Policy' };

export default function RefundsPage() {
  return (
    <LegalPage title="Refund and Cancellation Policy">
      <section>
        <h2>Trials and cancellation</h2>
        <p>New eligible businesses receive the trial shown during signup. No payment card is required for the cardless trial. Paid subscriptions can be cancelled through the hosted billing portal. Cancellation takes effect at the end of the current paid billing period unless the law requires otherwise.</p>
      </section>
      <section>
        <h2>Refunds</h2>
        <p>Charges are non-refundable after a billing period begins, except where required by law or when Echo Grid confirms a duplicate or erroneous charge. Cancelling stops future renewals but does not automatically refund the current period.</p>
      </section>
      <section>
        <h2>Failed payments and access</h2>
        <p>If a renewal fails, the account may remain operational during the stated grace period while payment is retried. Continued failure may reduce or suspend paid functionality. Echo Grid does not delete customer data solely because a payment fails.</p>
      </section>
      <section>
        <h2>Requesting help</h2>
        <p>Send billing questions and eligible refund requests to <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>. Include the business name, invoice date, amount, and reason for the request, but never send full card details.</p>
      </section>
    </LegalPage>
  );
}
