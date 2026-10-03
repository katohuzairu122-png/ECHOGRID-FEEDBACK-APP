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

export class TwilioVerifyService {
  constructor(private readonly credentials: TwilioVerifyCredentials) {}

  private async post(
    path: string,
    body: URLSearchParams,
    missingVerificationIsInvalid = false,
  ): Promise<TwilioVerifyResponse> {
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
      // Twilio removes a verification after it expires, is approved, or
      // reaches its attempt limit. VerificationCheck then returns 404/20404;
      // that means the submitted code is no longer valid, not that Twilio is
      // unavailable.
      if (
        missingVerificationIsInvalid &&
        (response.status === 404 || payload.code === 20404)
      ) {
        return payload;
      }

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
      true,
    );
    return result.status === 'approved';
  }
}
