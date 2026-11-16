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

  it('offers no still-image upload: the cashier scans with the camera or enters the token', () => {
    const { container } = render(<QrCameraScanner onDetect={vi.fn()} />);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/upload a photo/i)).toBeNull();
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
      value: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
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

describe('QrCameraScanner remediation (QR-REMEDIATION-01)', () => {
  function camera(getUserMedia: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  }

  it('opens one camera for a double tap and releases every track', async () => {
    const stopTrack = vi.fn();
    let resolve!: (s: unknown) => void;
    const getUserMedia = vi.fn(() => new Promise((r) => (resolve = r)));
    camera(getUserMedia);
    const user = userEvent.setup();
    render(<QrCameraScanner onDetect={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Scan customer QR' });
    await user.click(button);
    await user.click(button);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    resolve({ getTracks: () => [{ stop: stopTrack }] });
    await screen.findByRole('button', { name: 'Stop camera' });
  });

  it('releases a camera that finishes opening after the page was left', async () => {
    const stopTrack = vi.fn();
    let resolve!: (s: unknown) => void;
    camera(vi.fn(() => new Promise((r) => (resolve = r))));
    const { unmount } = render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    unmount();
    resolve({ getTracks: () => [{ stop: stopTrack }] });
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });

  it.each([
    ['NotAllowedError', 'The camera could not be opened. Allow camera access'],
    ['NotFoundError', 'No camera was found on this device'],
    ['NotReadableError', 'The camera is in use by another app or tab'],
    ['SomethingElse', 'The camera could not be started'],
  ])('reports %s truthfully, not always as "denied"', async (name, text) => {
    camera(vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name })));
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('delivers the result to the latest callback', async () => {
    const first = vi.fn();
    const second = vi.fn();
    camera(vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }));
    const { rerender } = render(<QrCameraScanner onDetect={first} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    rerender(<QrCameraScanner onDetect={second} />);
    await waitFor(() => expect(second).toHaveBeenCalledWith('local.token.1'), { timeout: 2000 });
    expect(first).not.toHaveBeenCalled();
  });
});
