import { describe, expect, it } from 'vitest';
import { businessQrTarget } from './business-qr-target';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxciJ9.c2lnbmF0dXJlLWJ5dGVz';

describe('businessQrTarget', () => {
  it('turns a printed feedback link into the same-site feedback path, whatever host printed it', () => {
    expect(businessQrTarget(`https://any.example/feedback/${TOKEN}`)).toBe(`/feedback/${TOKEN}`);
    expect(businessQrTarget(`https://other.host/loyalty/${TOKEN}?x=1#y`)).toBe(`/feedback/${TOKEN}`);
    expect(businessQrTarget(`/feedback/${TOKEN}`)).toBe(`/feedback/${TOKEN}`);
  });
  it('accepts a bare token', () => {
    expect(businessQrTarget(`  ${TOKEN}\n`)).toBe(`/feedback/${TOKEN}`);
  });
  it('never returns an external destination', () => {
    expect(businessQrTarget('https://evil.example/')).toBeNull();
    expect(businessQrTarget('//evil.example/feedback/x')).toBeNull();
    expect(businessQrTarget(`https://evil.example/feedback/${TOKEN}`)?.startsWith('/feedback/')).toBe(true);
    expect(businessQrTarget(`javascript:alert(1)//feedback/${TOKEN}`)).toBeNull();
  });
  it('rejects anything that is not a business QR', () => {
    for (const bad of ['', '   ', 'hello', '+15551234567', 'https://example.com/feedback/short', `https://x.test/dashboard/${TOKEN}`, 'a.b.c', 'x'.repeat(7000)]) {
      expect(businessQrTarget(bad), bad.slice(0, 20)).toBeNull();
    }
  });
  it('rejects a malformed percent escape without throwing', () => {
    expect(businessQrTarget('https://x.test/feedback/%E0%A4%A')).toBeNull();
  });
});
