'use client';

import { useEffect } from 'react';
import { recordQrScanAction } from '@/lib/actions/qr-scan';

const STORAGE_KEY = 'echo-grid-scan-signal';

export function dailyScanSignal(storage: Pick<Storage, 'getItem' | 'setItem'>, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const existing = storage.getItem(STORAGE_KEY);
  if (existing?.startsWith(`${day}:`)) return existing;
  const signal = `${day}:${crypto.randomUUID()}`;
  storage.setItem(STORAGE_KEY, signal);
  return signal;
}

export function QrScanRecorder({ token }: { token: string }) {
  useEffect(() => {
    const signal = dailyScanSignal(window.localStorage);
    // Analytics must never block or disrupt the anonymous feedback flow.
    void recordQrScanAction(token, signal).catch(() => undefined);
  }, [token]);
  return null;
}

