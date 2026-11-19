import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AssistedInvitePreviewDto } from '@echo-grid-feedback/shared-types';

vi.mock('@/lib/actions/loyalty-customer', () => ({ joinAssistedAction: vi.fn() }));

import { InvitePanel } from './invite-panel';

/**
 * CASHIER-AUTH-02D: the customer invitation page really renders in French, Spanish and Arabic (not just present as JSON): translated
 * text, the business and branch interpolated, no raw message keys on screen, and a right-to-left document for Arabic.
 */
const messagesFor = (locale: string) => ({
  loyalty: JSON.parse(readFileSync(join(__dirname, `../../../../../messages/${locale}/loyalty.json`), 'utf8')),
  cashier: JSON.parse(readFileSync(join(__dirname, `../../../../../messages/${locale}/cashier.json`), 'utf8')),
});
const preview: AssistedInvitePreviewDto = { status: 'ready', businessName: 'Café Étoile', branchName: 'Port', businessId: 'b', expiresAt: '2026-11-19T10:10:00.000Z' };
const draw = (locale: string, props: Partial<Parameters<typeof InvitePanel>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messagesFor(locale)}>
      <div dir={locale === 'ar' ? 'rtl' : 'ltr'} data-testid="root">
        <InvitePanel token="tok.part.sig" signedIn preview={preview} invalid={false} {...props} />
      </div>
    </NextIntlClientProvider>,
  );

describe.each([
  ['fr', 'Rejoindre Café Étoile', 'Vous avez été invité à Port.', 'Rejoindre'],
  ['es', 'Unirse a Café Étoile', 'Le invitaron en Port.', 'Unirme'],
  ['ar', 'الانضمام إلى Café Étoile', 'تمت دعوتك في Port.', 'انضمام'],
] as const)('invitation page in %s', (locale, title, subtitle, joinLabel) => {
  it('renders the translated title, subtitle and action with the business and branch filled in, and no raw keys', () => {
    draw(locale);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: joinLabel })).toBeDisabled(); // consent still required
    expect(document.body.textContent).not.toMatch(/loyalty\.customer\.invite|cashier\.invite|\{businessName\}|\{branchName\}/);
  });

  it('renders the signed-out and invalid states translated', () => {
    const { unmount } = draw(locale, { signedIn: false, preview: null });
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/loyalty\.customer\.invite/);
    unmount();
    draw(locale, { preview: null, invalid: true });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/loyalty\.customer\.invite/);
  });
});

describe('Arabic is laid out right to left', () => {
  it('the page root is rtl and uses no left/right-only spacing that would break the layout', () => {
    draw('ar');
    expect(screen.getByTestId('root')).toHaveAttribute('dir', 'rtl');
    const source = readFileSync(join(__dirname, 'invite-panel.tsx'), 'utf8');
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right|text-left|text-right)-/);
  });
});
