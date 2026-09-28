'use server';

import { publicApiFetch } from '@/lib/public-api-client';

export async function recordQrScanAction(token: string, deviceSignal: string): Promise<void> {
  await publicApiFetch(`/qr/${token}/scan`, {
    method: 'POST',
    body: JSON.stringify({ deviceSignal }),
  });
}

