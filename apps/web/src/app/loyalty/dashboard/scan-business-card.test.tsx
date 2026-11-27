import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { ScanBusinessCard } from './scan-business-card';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

let detect: (value: string) => void = () => undefined;
vi.mock('@/components/qr-camera-scanner', () => ({
  QrCameraScanner: ({ onDetect, namespace }: { onDetect: (v: string) => void; namespace?: string }) => {
    detect = onDetect;
    return <div data-testid="scanner" data-namespace={namespace} />;
  },
}));

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxciJ9.c2lnbmF0dXJlLWJ5dGVz';

describe('ScanBusinessCard (customer account)', () => {
  beforeEach(() => push.mockClear());

  it('shows a start button first, then the camera scanner with customer wording', () => {
    renderWithIntl(<ScanBusinessCard />);
    expect(screen.queryByTestId('scanner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /scan a business qr code/i }));
    expect(screen.getByTestId('scanner').getAttribute('data-namespace')).toBe('loyalty.customer.scanBusiness');
  });

  it('opens the same-site business page when a business QR is scanned', () => {
    renderWithIntl(<ScanBusinessCard />);
    fireEvent.click(screen.getByRole('button', { name: /scan a business qr code/i }));
    act(() => detect(`https://printed.example/feedback/${TOKEN}`));
    expect(push).toHaveBeenCalledWith(`/feedback/${TOKEN}`);
  });

  it('refuses a code that is not a business QR and opens nothing', () => {
    renderWithIntl(<ScanBusinessCard />);
    fireEvent.click(screen.getByRole('button', { name: /scan a business qr code/i }));
    act(() => detect('https://evil.example/'));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not a business QR code/i);
  });
});
