'use client';

import { useEffect, useState } from 'react';

/**
 * Tells the cashier plainly when the device has no connection. Loyalty actions are never queued or replayed offline:
 * every one is a live server call, so the banner only explains why they cannot run.
 */
export function OfflineBanner({ title, body }: { title: string; body: string }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  if (online) return null;
  return (
    <div role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">{title}</p>
      <p>{body}</p>
    </div>
  );
}
