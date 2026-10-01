import { AppError } from '../lib/errors';

export interface TwilioVerifyCredentials {
  accountSid: string;
  authToken: string;
  serviceSid: string;
}

interface TwilioVerifyResponse {
  status?: string;
  code?: number;
  message?: string;
}

/**
 * Cloudflare Workers-compatible Twilio Verify client. Verify owns OTP
 * generation, delivery, expiry, attempt limits, and one-time consumption;
 * Echo Grid only asks it to start a verification and approve a submitted
 * code. This avoids provisioning an SMS-capable sender number solely for
 * login codes.
 */
export class TwilioVerifyService {
  constructor(private readonly credentials: TwilioVerifyCredentials) {}

  private async post(path: string, body: URLSearchParams): Promise<TwilioVerifyResponse> {
    const { accountSid, authToken, serviceSid } = this.credentials;
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${serviceSid}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );

    const payload = (await response.json().catch(() => ({}))) as TwilioVerifyResponse;
    if (!response.ok) {
      // Provider code and HTTP status are safe diagnostics. Do not include
      // Twilio's free-text response because it can echo phone numbers.
      console.error('Twilio Verify request failed.', {
        providerCode: payload.code,
        status: response.status,
      });
      throw new AppError(
        'The verification service is temporarily unavailable. Please try again.',
        500,
        'OTP_PROVIDER_ERROR',
      );
    }
    return payload;
  }

  async request(phone: string): Promise<void> {
    await this.post('Verifications', new URLSearchParams({ To: phone, Channel: 'sms' }));
  }

  async check(phone: string, code: string): Promise<boolean> {
    const result = await this.post(
      'VerificationCheck',
      new URLSearchParams({ To: phone, Code: code }),
    );
    return result.status === 'approved';
  }
}
