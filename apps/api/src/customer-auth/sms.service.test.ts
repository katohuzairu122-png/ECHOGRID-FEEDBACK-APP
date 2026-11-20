import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSmsService, TwilioSmsService, createSmsService, maskPhone } from './sms.service';

const creds = { accountSid: 'AC00000000000000000000000000000000', authToken: 'x', fromNumber: '+15550000000' } as never;

describe('SMS service selection and console masking (D2-FINAL)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('masks all but the last four digits', () => {
    expect(maskPhone('+15551234567')).toBe('+•••••••4567');
    expect(maskPhone('5551234567')).toBe('••••••4567');
    expect(maskPhone('1234')).toBe('••••');
    expect(maskPhone('')).toBe('••••');
  });

  it('production uses Twilio; staging and development use the console fallback', () => {
    expect(createSmsService('production', creds)).toBeInstanceOf(TwilioSmsService);
    expect(createSmsService('staging', creds)).toBeInstanceOf(ConsoleSmsService);
    expect(createSmsService('development', creds)).toBeInstanceOf(ConsoleSmsService);
  });

  it('staging logs a masked recipient but keeps the code readable; development is unchanged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createSmsService('staging', creds).send('+15551234567', 'Your code is 424242');
    expect(log.mock.calls[0]![0]).toBe('[ConsoleSmsService] would send to +•••••••4567: Your code is 424242');
    expect(String(log.mock.calls[0]![0])).not.toContain('15551234567');
    await createSmsService('development', creds).send('+15551234567', 'Your code is 424242');
    expect(log.mock.calls[1]![0]).toBe('[ConsoleSmsService] would send to +15551234567: Your code is 424242');
  });
});
