import { randomBytes } from 'node:crypto';
import { HarnessRefusal, type TargetsConfig } from './guard';
import type { VerificationMailbox } from './verification-mailbox';
import type { CustomerProvisioner, Provisioned } from './scenarios';

/**
 * CASHIER-AUTH-02E E2-A: the live customer provisioner.
 *
 * It creates a synthetic customer only through the REAL sign-up flow, driven by a {@link SignupDriver} (a browser through the web Worker,
 * because the API accepts sign-ups only from the trusted web source): request the confirmation link for an approved synthetic address,
 * read that link from the approved test mailbox, set the password, sign in. It never writes to a database, never skips the link or
 * authentication, never uses an address that is not `acc-<runId>-<label>@<approved domain>`, and never deletes or cleans anything up
 * (there is deliberately no such method). It cannot be constructed unless the owner's three approvals are recorded in the committed
 * configuration: the staging hostnames, the test mailbox and customer provisioning.
 */
export interface SignupDriver {
  /** Asks the real sign-up page to send a confirmation link to this address. */
  requestSignup(email: string): Promise<void>;
  /** Opens the confirmation link and sets the password. */
  completeSignup(verifyUrl: string, password: string): Promise<void>;
  /** Signs in through the real sign-in page and returns the customer's identity and access token. */
  signIn(email: string, password: string): Promise<{ customerId: string; accessToken: string }>;
}

export interface ProvisionerOptions {
  runId: string;
  config: TargetsConfig;
  mailbox: VerificationMailbox;
  driver: SignupDriver;
  now?: () => number;
}

const LABEL = /^[a-z0-9]{1,16}$/;
const RUN_ID = /^[a-z0-9]{4,12}$/;

/** Which of the three approvals are missing, by name (never a value). */
export function missingApprovals(config: TargetsConfig): string[] {
  const missing: string[] = [];
  if (!(config.approved && config.approvedBy !== null && config.approvedAt !== null)) missing.push('staging hostnames');
  if (!(config.mailbox.approved && config.mailbox.adapter !== 'none' && config.mailbox.allowedRecipientDomains.length > 0)) missing.push('test mailbox');
  if (!(config.customerProvisioning.approved && config.customerProvisioning.approvedBy !== null)) missing.push('customer provisioning');
  return missing;
}

export class LiveCustomerProvisioner implements CustomerProvisioner {
  readonly kind = 'live-web-signup';
  readonly canSetPhoneVerified = false;
  private readonly domain: string;
  private readonly now: () => number;
  private readonly known = new Map<string, { email: string; password: string; id: string }>();

  constructor(private readonly opts: ProvisionerOptions) {
    if (!RUN_ID.test(opts.runId)) throw new HarnessRefusal('PROVISIONER_REFUSED', 'The run identifier is not valid.');
    const { config } = opts;
    if (!(config.approved && config.approvedBy !== null && config.approvedAt !== null)) {
      throw new HarnessRefusal('LIVE_NOT_APPROVED', 'The staging hostnames are not approved by the owner.');
    }
    if (!(config.mailbox.approved && config.mailbox.adapter !== 'none' && config.mailbox.allowedRecipientDomains.length > 0)) {
      throw new HarnessRefusal('MAILBOX_NOT_APPROVED', 'No test mailbox is approved.');
    }
    if (!(config.customerProvisioning.approved && config.customerProvisioning.approvedBy !== null)) {
      throw new HarnessRefusal('IDENTITY_NOT_APPROVED', 'Creating synthetic customers is not approved by the owner.');
    }
    this.domain = config.mailbox.allowedRecipientDomains[0] as string;
    this.now = opts.now ?? (() => Date.now());
  }

  private address(label: string): string {
    if (!LABEL.test(label)) throw new HarnessRefusal('PROVISIONER_REFUSED', 'The customer label is not valid.');
    return `acc-${this.opts.runId}-${label}@${this.domain}`;
  }

  /** A NEW customer through the real sign-up. Asking again for the same label returns the same customer and creates nothing. */
  async create(label: string, opts?: { phoneVerified?: boolean }): Promise<Provisioned> {
    if (opts?.phoneVerified) {
      throw new HarnessRefusal('PROVISIONER_REFUSED', 'A phone-verified customer needs a real SMS code, which is not available to the harness.');
    }
    const email = this.address(label);
    const have = this.known.get(label);
    if (have) return this.returning(label);
    const password = `Acc-${randomBytes(12).toString('base64url')}-9`;
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof HarnessRefusal) throw error;
        // The cause is dropped on purpose: it could carry a link, a token or an address.
        throw new Error(`customer provisioning failed at step "${name}"`);
      }
    };
    const sinceMs = this.now();
    await step('request sign-up', () => this.opts.driver.requestSignup(email));
    const verification = await this.opts.mailbox.fetchVerification({ recipient: email, purpose: 'customer-signup-link', sinceMs });
    if (verification.kind !== 'link') throw new HarnessRefusal('PROVISIONER_REFUSED', 'The mailbox did not return a verification link.');
    await step('complete sign-up', () => this.opts.driver.completeSignup(verification.url, password));
    const session = await step('sign in', () => this.opts.driver.signIn(email, password));
    this.known.set(label, { email, password, id: session.customerId });
    return { id: session.customerId, token: session.accessToken };
  }

  /** A customer created earlier in this run signs in again through the real sign-in page. */
  async returning(label: string): Promise<Provisioned> {
    const have = this.known.get(label);
    if (!have) throw new HarnessRefusal('PROVISIONER_REFUSED', 'No customer with this label was created in this run.');
    let session: { customerId: string; accessToken: string };
    try {
      session = await this.opts.driver.signIn(have.email, have.password);
    } catch {
      throw new Error('customer provisioning failed at step "returning sign in"');
    }
    if (session.customerId !== have.id) throw new HarnessRefusal('PROVISIONER_REFUSED', 'The returning sign-in identified a different customer.');
    return { id: session.customerId, token: session.accessToken };
  }
}
