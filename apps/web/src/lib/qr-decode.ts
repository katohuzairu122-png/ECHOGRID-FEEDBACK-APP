import type { QRCode } from 'jsqr';

/** Largest side, in pixels, a frame or image is scaled to before decoding (bounds CPU and memory). */
export const MAX_DECODE_SIDE = 800;

/**
 * Local QR decoding (jsQR, bundled with the app: no remote script, no network call, nothing leaves the
 * device). Used only where the browser has no native BarcodeDetector, on live camera frames. The decoder is loaded on first use so
 * the dependency does not weigh on pages that never scan.
 */
export async function decodeImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  const { default: jsQR } = await import('jsqr');
  const code: QRCode | null = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  const value = code?.data?.trim();
  return value ? value : null;
}

/** Scales (never enlarges) a source to MAX_DECODE_SIDE and reads its pixels. Null when no 2D canvas exists. */
export function readPixels(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
): { data: Uint8ClampedArray; width: number; height: number } | null {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}
