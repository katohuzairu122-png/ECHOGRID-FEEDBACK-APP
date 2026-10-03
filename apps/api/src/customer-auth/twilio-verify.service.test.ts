import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwilioVerifyService } from './twilio-verify.service';

const credentials = {
  accountSid: 'AC_test',
  authToken: 'secret',
  serviceSid: 'VA_test',
};

describe('TwilioVerifyService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts an SMS verification through the configured Verify service', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new TwilioVerifyService(credentials).request('+15551234567');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://verify.twilio.com/v2/Services/VA_test/Verifications',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(String(request.body)).toContain('To=%2B15551234567');
    expect(String(request.body)).toContain('Channel=sms');
  });

  it('accepts only a Verify response whose status is approved', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'approved' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new TwilioVerifyService(credentials);

    await expect(service.check('+15551234567', '123456')).resolves.toBe(true);
    await expect(service.check('+15551234567', '000000')).resolves.toBe(false);
  });

  it('treats an expired or already-consumed verification as an invalid code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 20404, message: 'Not found' }), { status: 404 }),
      ),
    );

    await expect(
      new TwilioVerifyService(credentials).check('+15551234567', '123456'),
    ).resolves.toBe(false);
  });

  it('returns a safe application error when Twilio rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 60200, message: 'Invalid parameter To: +15551234567' }), {
          status: 400,
        }),
      ),
    );

    await expect(new TwilioVerifyService(credentials).request('+15551234567')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_ERROR',
      status: 500,
      message: 'The verification service is temporarily unavailable. Please try again.',
    });
  });
});
