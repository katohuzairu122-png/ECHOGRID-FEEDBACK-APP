import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import type * as QrDecode from '@/lib/qr-decode';
import { QrCameraScanner } from './qr-camera-scanner';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

vi.mock('@/lib/qr-decode', async (orig) => ({
  ...(await orig<typeof QrDecode>()),
  readPixels: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  decodeImageData: vi.fn(async () => 'local.token.1'),
  decodeImageFile: vi.fn(),
}));

describe('QrCameraScanner', () => {
  it('falls back to the local decoder when BarcodeDetector is missing but the camera works', async () => {
    const stopTrack = vi.fn();
    const onDetect = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
      configurable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<QrCameraScanner onDetect={onDetect} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(onDetect).toHaveBeenCalledWith('local.token.1'), { timeout: 2000 });
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
  });

  it('explains an insecure (non-HTTPS) page without asking for the camera', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    vi.stubGlobal('isSecureContext', false);
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/secure \(HTTPS\)/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reads a code from an uploaded image and reports image errors', async () => {
    const { decodeImageFile } = await import('@/lib/qr-decode');
    const onDetect = vi.fn();
    vi.mocked(decodeImageFile)
      .mockResolvedValueOnce({ value: 'img.token.2' })
      .mockResolvedValueOnce({ value: null, reason: 'unreadable' });
    render(<QrCameraScanner onDetect={onDetect} />);
    const input = screen.getByLabelText('Upload a photo of the QR code', { selector: 'input' });
    const user = userEvent.setup();
    await user.upload(input, new File(['x'], 'qr.png', { type: 'image/png' }));
    await waitFor(() => expect(onDetect).toHaveBeenCalledWith('img.token.2'));
    await user.upload(input, new File(['x'], 'blank.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No QR code could be read/i);
  });

  it('explains the fallback when the browser has no camera API at all', async () => {
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available in this browser/i);
  });

  it('explains the fallback when the camera is denied', async () => {
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn(async () => []);
      },
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/camera could not be opened/i),
    );
  });

  it('reads a code, stops the camera and reports the value once', async () => {
    const stopTrack = vi.fn();
    const onDetect = vi.fn();
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn(async () => [{ rawValue: ' tok.123 ' }]);
      },
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
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
