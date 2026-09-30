import type { Metadata } from 'next';
import { LEGAL_CONTACT_EMAIL, LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <section>
        <h2>Agreement</h2>
        <p>These terms govern access to Echo Grid, a service operated by INFINICUS LLC. By creating an account or using the service, you agree to these terms and confirm that you can enter into this agreement for yourself or the business you represent.</p>
      </section>
      <section>
        <h2>Accounts and acceptable use</h2>
        <p>You must provide accurate account information, protect credentials, and promptly report suspected unauthorised access. You may not use Echo Grid unlawfully, interfere with the service, probe or bypass security controls, submit malicious content, impersonate others, or use the service to send spam or abusive communications.</p>
      </section>
      <section>
        <h2>Customer data</h2>
        <p>You retain ownership of information you submit. You grant us the limited rights needed to host, process, transmit, and analyse that information to provide and secure Echo Grid. You are responsible for having a lawful basis to collect customer information and for giving any notices or obtaining any consents your use requires.</p>
      </section>
      <section>
        <h2>Plans and service changes</h2>
        <p>Free, trial, and paid plans may have limits on responses, branches, users, or features. Current limits appear in the product before purchase. We may improve or modify the service and will give reasonable notice when a material change adversely affects paid use.</p>
      </section>
      <section>
        <h2>Availability and warranties</h2>
        <p>We work to keep Echo Grid reliable and secure, but the service is provided on an “as available” basis to the extent permitted by law. Scheduled maintenance, provider failures, emergencies, or events outside our reasonable control may interrupt access.</p>
      </section>
      <section>
        <h2>Suspension and termination</h2>
        <p>You may stop using the service at any time and may manage a paid subscription through the billing portal when available. We may restrict or suspend access for material breach, security risk, unlawful use, or non-payment after applicable notice and grace periods. Provisions that should reasonably survive termination remain effective.</p>
      </section>
      <section>
        <h2>Liability and contact</h2>
        <p>To the maximum extent permitted by law, neither party is liable for indirect, incidental, special, or consequential loss. Nothing in these terms excludes liability that cannot legally be excluded. Questions about these terms may be sent to <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.</p>
      </section>
    </LegalPage>
  );
}
