import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ConsoleEmailService,
  ResendEmailService,
  createAccountSecurityEmailService,
  createEmailService,
} from './email.service';

const credentials = {
  apiKey: 're_test_placeholder',
  fromAddress: 'Echo Grid <support@example.test>',
};

describe('createEmailService (notifications, team invites)', () => {
  it('sends for real only in production', () => {
    expect(createEmailService('production', credentials)).toBeInstanceOf(ResendEmailService);
  });

  it('stays log-only in staging and development', () => {
    expect(createEmailService('staging', credentials)).toBeInstanceOf(ConsoleEmailService);
    expect(createEmailService('development', credentials)).toBeInstanceOf(ConsoleEmailService);
  });
});

describe('createAccountSecurityEmailService (password reset / changed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends for real in production and staging', () => {
    expect(createAccountSecurityEmailService('production', credentials)).toBeInstanceOf(
      ResendEmailService,
    );
    expect(createAccountSecurityEmailService('staging', credentials)).toBeInstanceOf(
      ResendEmailService,
    );
  });

  it('stays log-only in development so wrangler dev prints the reset link', () => {
    expect(createAccountSecurityEmailService('development', credentials)).toBeInstanceOf(
      ConsoleEmailService,
    );
  });

  it('delivers a staging reset email through the Resend API with the configured sender', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createAccountSecurityEmailService('staging', credentials).send({
      to: 'owner@example.test',
      subject: 'Reset your Echo Grid password',
      html: '<p>link</p>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: credentials.fromAddress,
      to: ['owner@example.test'],
      subject: 'Reset your Echo Grid password',
    });
  });

  it('surfaces a Resend rejection instead of reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));

    await expect(
      createAccountSecurityEmailService('staging', credentials).send({
        to: 'a@example.test',
        subject: 's',
        html: 'h',
      }),
    ).rejects.toThrow('Email delivery failed with status 403');
  });
});
