import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decodeImageData, readPixels } from './qr-decode';

// Test-only encoder: qrcode-generator is a dependency of react-qr-code (already used by the app).
const requireFromQrLib = createRequire(createRequire(import.meta.url).resolve('react-qr-code'));
const qrcode = requireFromQrLib('qrcode-generator') as (
  type: number,
  level: string,
) => {
  addData(s: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(r: number, c: number): boolean;
};

function rasterize(text: string, scale = 8, margin = 4, invert = false) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      let dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
      if (invert) dark = !dark;
      const v = dark ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, size };
}

describe('local QR decoder (non-production fixtures)', () => {
  it('decodes a QR code from pixels', async () => {
    const { data, size } = rasterize('fixture.token.ABC-123_xyz');
    expect(await decodeImageData(data, size, size)).toBe('fixture.token.ABC-123_xyz');
  });
  it('decodes an inverted (light-on-dark) code', async () => {
    const { data, size } = rasterize('fixture-inverted', 8, 4, true);
    expect(await decodeImageData(data, size, size)).toBe('fixture-inverted');
  });
  it('returns null for an image with no code', async () => {
    const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(await decodeImageData(data, 64, 64)).toBeNull();
  });
  it('readPixels refuses empty sources and never enlarges', () => {
    const canvas = document.createElement('canvas');
    expect(readPixels({} as CanvasImageSource, 0, 0, canvas)).toBeNull();
  });
});
