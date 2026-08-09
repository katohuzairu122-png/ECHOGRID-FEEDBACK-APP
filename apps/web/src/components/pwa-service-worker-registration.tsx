'use client';

import { useEffect } from 'react';

/**
 * Registers public/sw.js on mount -- the one bit of PWA install plumbing
 * that has to run client-side. Mounted once in the root layout so it
 * applies to every route, not just the ones a user is likely to install
 * from. Silently no-ops in browsers without Service Worker support rather
 * than throwing.
 */
export function PwaServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installability is a nice-to-have, not a page-blocking requirement --
      // a registration failure (e.g. an unsupported browser quirk) should
      // never surface to the user.
    });
  }, []);

  return null;
}
