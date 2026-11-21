import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildRegistrationProofLink, createRegistrationProofDelivery } from './customer-email-auth.delivery';

describe('registration proof delivery', () => {
  it('puts the proof in the URL fragment, never in the path or query', () => {
    const link = buildRegistrationProofLink('https://app.example.test/', 'chal-1', 'p/r+o=o f');
    const url = new URL(link);
    expect(url.pathname).toBe('/loyalty/signup/verify');
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#c=')).toBe(true);
    expect(decodeURIComponent(url.hash.slice(3))).toBe('chal-1.p/r+o=o f');
  });

  it('preserves only a validated internal loyalty destination beside the proof fragment', () => {
    const next = '/loyalty/invite/synthetic-token';
    const url = new URL(buildRegistrationProofLink('https://app.example.test', 'chal-1', 'proof', next));
    expect(url.searchParams.get('next')).toBe(next);
    expect(url.hash).toBe(`#c=${encodeURIComponent('chal-1.proof')}`);
  });

  it('the link path is a page that exists in the web app (a 404 link silently breaks sign-up)', () => {
    const pathname = new URL(buildRegistrationProofLink('https://app.example.test', 'c', 'p')).pathname;
    expect(existsSync(join(__dirname, '../../../web/src/app', pathname, 'page.tsx'))).toBe(true);
  });

  it('sends one email to the recipient containing the link, and escapes it for HTML', async () => {
    const send = vi.fn(async () => {});
    await createRegistrationProofDelivery({ email: { send } as never, webBaseUrl: 'https://app.example.test' })({
      recipient: 'new@example.test', challengeId: 'chal-1', proof: 'proof-"><script>',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const message = (send.mock.calls[0] as unknown as [{ to: string; html: string; subject: string }])[0];
    expect(message.to).toBe('new@example.test');
    expect(message.html).toContain('https://app.example.test/loyalty/signup/verify#c=');
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toMatch(/password:/i);
  });

  it('lets a provider failure propagate (the caller treats delivery errors as silent)', async () => {
    const send = vi.fn(async () => { throw new Error('provider down'); });
    await expect(
      createRegistrationProofDelivery({ email: { send } as never, webBaseUrl: 'https://app.example.test' })({
        recipient: 'a@example.test', challengeId: 'c', proof: 'p',
      }),
    ).rejects.toThrow('provider down');
  });
});
