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
 * otherwise a bundled local decoder (jsQR). The caller's manual lookup remains available.
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
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const [requesting, setRequesting] = useState(false);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const release = useCallback(() => {
    generationRef.current += 1;
    runningRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setRequesting(false);
    setActive(false);
  }, [release]);

  useEffect(() => release, [release]);

  async function start() {
    if (runningRef.current) return;
    setMessage(null);
    if (window.isSecureContext === false) {
      setMessage(t('insecure'));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage(t('unsupported'));
      return;
    }
    runningRef.current = true;
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (!isCurrent()) return;
      setRequesting(false);
      setActive(true);
      let native: BarcodeDetectorLike | undefined;
      const Detector = getDetectorCtor();
      if (Detector) {
        try {
          native = new Detector({ formats: ['qr_code'] });
        } catch {
          // Some implementations expose the API without a usable QR detector.
        }
      }
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
      const canvas = canvasRef.current;
      let busy = false;
      timerRef.current = setInterval(async () => {
        if (busy || !isCurrent() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        busy = true;
        try {
          let value: string | undefined;
          if (native) {
            try {
              value = (await native.detect(video))[0]?.rawValue?.trim();
            } catch {
              native = undefined;
            }
          }
          if (!native && isCurrent()) {
            const pixels = readPixels(video, video.videoWidth, video.videoHeight, canvas);
            value = pixels
              ? ((await decodeImageData(pixels.data, pixels.width, pixels.height)) ?? undefined)
              : undefined;
          }
          if (value && isCurrent()) {
            stop();
            onDetect(value);
          }
        } catch {
          // A single failed frame is not fatal; keep scanning.
        } finally {
          busy = false;
        }
      }, 300);
    } catch (error) {
      if (!isCurrent()) return;
      stop();
      const name =
        typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setMessage(t('cameraMissing'));
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        setMessage(t('cameraUnavailable'));
      } else {
        setMessage(t('cameraDenied'));
      }
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
      {active || requesting ? (
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
      {(active || requesting) && (
        <p role="status" className="text-sm">
          {t(requesting ? 'cameraRequesting' : 'scanning')}
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
