import { describe, expect, it, vi } from 'vitest';
import { buildRegistrationProofLink, createRegistrationProofDelivery } from './customer-email-auth.delivery';

describe('registration proof delivery', () => {
  it('puts the proof in the URL fragment, never in the path or query', () => {
    const link = buildRegistrationProofLink('https://app.example.test/', 'chal-1', 'p/r+o=o f');
    const url = new URL(link);
    expect(url.pathname).toBe('/signup/verify');
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#c=')).toBe(true);
    expect(decodeURIComponent(url.hash.slice(3))).toBe('chal-1.p/r+o=o f');
  });

  it('sends one email to the recipient containing the link, and escapes it for HTML', async () => {
    const send = vi.fn(async () => {});
    await createRegistrationProofDelivery({ email: { send } as never, webBaseUrl: 'https://app.example.test' })({
      recipient: 'new@example.test', challengeId: 'chal-1', proof: 'proof-"><script>',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const message = (send.mock.calls[0] as unknown as [{ to: string; html: string; subject: string }])[0];
    expect(message.to).toBe('new@example.test');
    expect(message.html).toContain('https://app.example.test/signup/verify#c=');
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
