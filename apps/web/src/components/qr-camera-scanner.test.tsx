import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { QrCameraScanner } from './qr-camera-scanner';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: undefined,
    configurable: true,
  });
});

vi.mock('@/lib/qr-decode', () => ({
  readPixels: vi.fn(() => ({
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
  })),
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
    render(<QrCameraScanner onDetect={onDetect} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(onDetect).toHaveBeenCalledWith('local.token.1'), { timeout: 2000 });
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
  });

  it('explains an insecure page even when the browser hides the camera API', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
    });
    vi.stubGlobal('isSecureContext', false);
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/secure \(HTTPS\)/i);
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
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/camera could not be opened/i),
    );
  });

  it.each([
    ['NotFoundError', /no camera was found/i],
    ['NotReadableError', /the camera could not start/i],
  ])('explains %s and allows a retry', async (name, message) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('', name)),
      },
      configurable: true,
    });
    render(<QrCameraScanner onDetect={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Scan customer QR' })).toBeEnabled();
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
    render(<QrCameraScanner onDetect={onDetect} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(onDetect).toHaveBeenCalledWith('tok.123'), {
      timeout: 2000,
    });
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByLabelText(/camera/i)).toHaveProperty('srcObject', null);
  });

  it.each(['constructor', 'frame'] as const)(
    'uses the local decoder if the native detector fails during %s',
    async (stage) => {
      vi.stubGlobal(
        'BarcodeDetector',
        class {
          constructor() {
            if (stage === 'constructor') throw new Error('Unsupported format');
          }
          detect = vi.fn().mockRejectedValue(new Error('Native decode failed'));
        },
      );
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
        },
        configurable: true,
      });
      const onDetect = vi.fn();
      render(<QrCameraScanner onDetect={onDetect} />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Scan customer QR' }));
      await waitFor(() => expect(onDetect).toHaveBeenCalledExactlyOnceWith('local.token.1'));
    },
  );

  it('stops a camera granted after leaving the page without submitting a code', async () => {
    const stopTrack = vi.fn();
    let grantCamera!: (stream: Pick<MediaStream, 'getTracks'>) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          grantCamera = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    const onDetect = vi.fn();
    const { unmount } = render(<QrCameraScanner onDetect={onDetect} />);
    await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Scan customer QR' }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      const track = { stop: stopTrack } as unknown as MediaStreamTrack;
      grantCamera({ getTracks: () => [track] });
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onDetect).not.toHaveBeenCalled();
  });

  it('ignores a frame that finishes decoding after the cashier stops scanning', async () => {
    let finishFrame!: (codes: { rawValue: string }[]) => void;
    const detect = vi.fn(
      () =>
        new Promise((resolve) => {
          finishFrame = resolve;
        }),
    );
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = detect;
      },
    );
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      },
      configurable: true,
    });
    const onDetect = vi.fn();
    const user = userEvent.setup();
    render(<QrCameraScanner onDetect={onDetect} />);
    await user.click(screen.getByRole('button', { name: 'Scan customer QR' }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /stop/i }));
    await act(async () => finishFrame([{ rawValue: 'late.code' }]));
    expect(onDetect).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
