'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { decodeImageData, readPixels } from '@/lib/qr-decode';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

function getDetectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

/**
 * Camera QR scanner for the cashier tab. Uses the browser's built-in BarcodeDetector where it exists and
 * otherwise a local decoder (jsQR, bundled; nothing is fetched or sent anywhere), so a missing
 * BarcodeDetector no longer means "no scanning". Where there is no camera at all, the camera is denied or
 * the page is not a secure context, it says so; an image upload and the caller's manual token field remain.
 * The camera stops as soon as a code is read, on Stop, or on unmount. A detected value is reported once and
 * is never logged or placed in a URL.
 */
export function QrCameraScanner({
  onDetect,
  large = false,
}: {
  onDetect: (value: string) => void;
  /** Cashier landing: one very large primary Scan button. */
  large?: boolean;
}) {
  const t = useTranslations('loyalty.staff.serve');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setActive(false);
  }, []);

  useEffect(() => stop, [stop]);

  async function start() {
    setMessage(null);
    const Detector = getDetectorCtor();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage(t('unsupported'));
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setMessage(t('insecure'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      setActive(true);
      const native = Detector ? new Detector({ formats: ['qr_code'] }) : null;
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
      const canvas = canvasRef.current;
      let busy = false;
      let done = false;
      timerRef.current = setInterval(async () => {
        if (busy || done) return;
        busy = true;
        try {
          let value: string | undefined;
          if (native) {
            value = (await native.detect(video))[0]?.rawValue?.trim();
          } else {
            const pixels = readPixels(video, video.videoWidth, video.videoHeight, canvas);
            value = pixels
              ? ((await decodeImageData(pixels.data, pixels.width, pixels.height)) ?? undefined)
              : undefined;
          }
          if (value && !done) {
            done = true;
            stop();
            onDetect(value);
          }
        } catch {
          // A single failed frame is not fatal; keep scanning.
        } finally {
          busy = false;
        }
      }, 300);
    } catch {
      stop();
      setMessage(t('cameraDenied'));
    }
  }

  return (
    <div className="space-y-3">
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={t('viewfinder')}
        className={active ? 'aspect-square w-full rounded-xl bg-black object-cover' : 'hidden'}
      />
      {active ? (
        <Button
          type="button"
          variant="outline"
          onClick={stop}
          className={large ? 'w-full' : undefined}
        >
          {t('stop')}
        </Button>
      ) : (
        <Button
          type="button"
          onClick={start}
          className={large ? 'h-auto min-h-40 w-full text-2xl font-semibold' : undefined}
        >
          {t(large ? 'scanLarge' : 'scan')}
        </Button>
      )}
      {active && (
        <p role="status" className="text-sm">
          {t('scanning')}
        </p>
      )}
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
