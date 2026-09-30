import type { Metadata } from 'next';
import { LEGAL_CONTACT_EMAIL, LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Cookie Policy' };

export default function CookiesPage() {
  return (
    <LegalPage title="Cookie Policy">
      <section>
        <h2>How Echo Grid uses cookies</h2>
        <p>Echo Grid uses cookies and similar browser storage that are necessary to authenticate users, protect sessions, preserve security state, and provide requested application features.</p>
      </section>
      <section>
        <h2>Essential storage</h2>
        <p>Authentication and refresh cookies keep signed-in sessions working. Customer-session and impersonation-related cookies support the corresponding requested workflows. These controls are essential to provide the service and are not used for advertising.</p>
      </section>
      <section>
        <h2>Analytics and advertising</h2>
        <p>Echo Grid currently does not set optional advertising cookies or third-party behavioural tracking cookies. If that changes, this policy and any required consent controls will be updated before optional tracking is enabled.</p>
      </section>
      <section>
        <h2>Your controls</h2>
        <p>You can block or delete cookies through your browser. Blocking essential cookies will prevent login and other authenticated features from working. Questions can be sent to <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.</p>
      </section>
    </LegalPage>
  );
}
