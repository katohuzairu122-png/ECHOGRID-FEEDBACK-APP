import type { Metadata } from 'next';
import { LEGAL_CONTACT_EMAIL, LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <section>
        <h2>Who we are</h2>
        <p>Echo Grid is a customer feedback, loyalty, messaging, and analytics service operated by INFINICUS LLC. This policy explains how we handle personal information when businesses, their staff, and their customers use Echo Grid.</p>
      </section>
      <section>
        <h2>Information we collect</h2>
        <ul>
          <li>Account and business information, including names, email addresses, roles, branch details, and account settings.</li>
          <li>Customer information supplied through feedback, loyalty, messaging, and notification features, including responses, ratings, contact details, and message content.</li>
          <li>Service data such as authentication events, audit records, QR scans, device or network-derived fraud signals, and technical logs.</li>
          <li>Subscription and invoice status received from our payment provider. Echo Grid does not store complete card numbers.</li>
        </ul>
      </section>
      <section>
        <h2>How we use information</h2>
        <p>We use information to provide and secure the service, process feedback and loyalty activity, deliver requested messages and notifications, prevent abuse, support users, improve reliability, and meet legal obligations. AI-assisted features may analyse feedback to produce sentiment labels, summaries, and suggested actions.</p>
      </section>
      <section>
        <h2>How information is shared</h2>
        <p>We share information with service providers only as needed to operate Echo Grid, including hosting, databases, email, SMS, AI processing, monitoring, and payments. We may also disclose information when required by law, to protect users or the service, or as part of a corporate transaction subject to appropriate safeguards.</p>
      </section>
      <section>
        <h2>Retention and security</h2>
        <p>We retain information while an account is active and as reasonably needed for service delivery, security, dispute resolution, and legal compliance. Retention periods vary by record type. We use access controls, encryption in transit, tenant isolation, audit logging, and secret-management controls, but no online service can guarantee absolute security.</p>
      </section>
      <section>
        <h2>Your choices and requests</h2>
        <p>Depending on where you live, you may have rights to access, correct, export, restrict, object to, or delete personal information. A business using Echo Grid may be responsible for responding to requests concerning customer data it controls. Contact us at <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.</p>
      </section>
      <section>
        <h2>International processing and changes</h2>
        <p>Our providers may process information in countries other than yours. Where required, we use appropriate transfer safeguards. We may update this policy and will publish the new effective date on this page.</p>
      </section>
    </LegalPage>
  );
}
