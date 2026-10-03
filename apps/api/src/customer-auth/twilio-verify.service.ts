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

      // These are expected, actionable Verify rejections rather than a
      // provider outage. Twilio keeps one verification lifecycle alive for
      // about ten minutes and permits at most five sends in that lifecycle.
      // Exposing that recovery instruction prevents customers from repeatedly
      // pressing Send code while the same lifecycle remains locked.
      if (
        response.status === 429 ||
        payload.code === 60203 ||
        payload.code === 60207 ||
        payload.code === 60212 ||
        payload.code === 60624 ||
        payload.code === 60626
      ) {
        throw new AppError(
          'Too many verification codes were requested. Please wait 10 minutes, then request a new code.',
          429,
          'OTP_SEND_LIMIT',
        );
      }

      if (
        payload.code === 60238 ||
        payload.code === 60410 ||
        payload.code === 60412 ||
        payload.code === 60605
      ) {
        throw new AppError(
          'SMS verification is currently blocked for this number. Please contact support.',
          403,
          'OTP_DELIVERY_BLOCKED',
        );
      }

      if (
        payload.code === 60006 ||
        payload.code === 60200 ||
        payload.code === 60205 ||
        payload.code === 60610 ||
        payload.code === 60612 ||
        payload.code === 60625
      ) {
        throw new AppError(
          'Enter a valid mobile number in international format, including the country code.',
          400,
          'OTP_PHONE_INVALID',
        );
      }

      throw new AppError(
        'The verification service is temporarily unavailable. Please try again.',
        503,
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
