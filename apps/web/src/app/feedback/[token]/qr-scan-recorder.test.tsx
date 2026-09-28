import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordQrScanAction } from '@/lib/actions/qr-scan';
import { dailyScanSignal, QrScanRecorder } from './qr-scan-recorder';

vi.mock('@/lib/actions/qr-scan', () => ({ recordQrScanAction: vi.fn() }));

describe('QrScanRecorder', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(recordQrScanAction).mockResolvedValue();
  });

  it('reuses one anonymous signal during the same UTC day and rotates the next day', () => {
    const first = dailyScanSignal(localStorage, new Date('2026-09-28T01:00:00Z'));
    expect(dailyScanSignal(localStorage, new Date('2026-09-28T23:59:00Z'))).toBe(first);
    expect(dailyScanSignal(localStorage, new Date('2026-09-29T00:00:00Z'))).not.toBe(first);
  });

  it('records after mount without rendering or blocking the form', async () => {
    const { container } = render(<QrScanRecorder token="signed-token" />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(recordQrScanAction).toHaveBeenCalledWith('signed-token', expect.any(String)));
  });
});

