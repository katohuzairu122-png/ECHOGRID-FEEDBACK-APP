'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

function getDetectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

/**
 * Camera QR scanner for the cashier tab. Uses the browser's built-in
 * BarcodeDetector (no new dependency). Where it is unavailable (e.g. iOS
 * Safari) or the camera is denied, it says so and the caller's paste field
 * remains the way in. The camera stops as soon as a code is read, on Stop, or
 * on unmount.
 */
export function QrCameraScanner({ onDetect }: { onDetect: (value: string) => void }) {
  const t = useTranslations('loyalty.staff.serve');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setMessage(t('unsupported'));
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
      const detector = new Detector({ formats: ['qr_code'] });
      let busy = false;
      timerRef.current = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const codes = await detector.detect(video);
          const value = codes[0]?.rawValue?.trim();
          if (value) {
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
        <Button type="button" variant="outline" onClick={stop}>
          {t('stop')}
        </Button>
      ) : (
        <Button type="button" onClick={start}>
          {t('scan')}
        </Button>
      )}
      {active && <p role="status" className="text-sm">{t('scanning')}</p>}
      {message && <p role="alert" className="text-sm">{message}</p>}
    </div>
  );
}
