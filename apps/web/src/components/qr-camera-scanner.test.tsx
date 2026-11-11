import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { QrCameraScanner } from './qr-camera-scanner';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('QrCameraScanner', () => {
  it('explains the paste fallback when BarcodeDetector is unavailable', async () => {
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not supported in this browser/i);
  });

  it('explains the fallback when the camera is denied', async () => {
    vi.stubGlobal('BarcodeDetector', class { detect = vi.fn(async () => []); });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/camera could not be opened/i));
  });

  it('reads a code, stops the camera and reports the value once', async () => {
    const stopTrack = vi.fn();
    const onDetect = vi.fn();
    vi.stubGlobal('BarcodeDetector', class { detect = vi.fn(async () => [{ rawValue: ' tok.123 ' }]); });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
      configurable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<QrCameraScanner onDetect={onDetect} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(onDetect).toHaveBeenCalledWith('tok.123'), { timeout: 2000 });
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
  });
});
