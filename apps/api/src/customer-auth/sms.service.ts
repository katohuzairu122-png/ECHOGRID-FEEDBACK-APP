/**
 * SMS delivery abstraction. TwilioSmsService calls Twilio's REST API via
 * plain fetch() rather than the official Node SDK -- the SDK's Workers
 * runtime compatibility is unverified, and a raw fetch against a documented
 * REST endpoint is a handful of lines, consistent with this project's
 * PBKDF2-over-Argon2 reasoning (native/simple over SDK-with-unverified-
 * Workers-support). ConsoleSmsService is the dev-mode fallback so local/
 * staging work never spends real Twilio credit -- selected by
 * createSmsService() based on ENVIRONMENT, never by the caller directly.
 */
export interface SmsService {
  send(toPhone: string, body: string): Promise<void>;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export class TwilioSmsService implements SmsService {
  constructor(private readonly credentials: TwilioCredentials) {}

  async send(toPhone: string, body: string): Promise<void> {
    const { accountSid, authToken, fromNumber } = this.credentials;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const auth = btoa(`${accountSid}:${authToken}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toPhone, From: fromNumber, Body: body }),
    });

    if (!response.ok) {
      // Twilio's error body isn't logged verbatim -- it can echo back the
      // phone number and message content, which we don't want in logs.
      throw new Error(`SMS delivery failed with status ${response.status}`);
    }
  }
}

/** Dev/staging fallback -- logs instead of sending, so OTP codes are visible
 * in `wrangler dev` output for manual testing without a real phone/Twilio
 * account. Never selected when ENVIRONMENT === 'production'. */
export class ConsoleSmsService implements SmsService {
  async send(toPhone: string, body: string): Promise<void> {
    console.log(`[ConsoleSmsService] would send to ${toPhone}: ${body}`);
  }
}

export function createSmsService(
  environment: 'development' | 'staging' | 'production',
  credentials: TwilioCredentials,
): SmsService {
  return environment === 'production' ? new TwilioSmsService(credentials) : new ConsoleSmsService();
}
