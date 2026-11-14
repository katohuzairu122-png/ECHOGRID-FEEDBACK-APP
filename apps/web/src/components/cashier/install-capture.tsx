'use client';

import { useEffect } from 'react';
import { installStore, type InstallPromptEvent } from './install-store';

/** Mounted once in the cashier layout so the install prompt is captured wherever the cashier opened the app. */
export function InstallCapture() {
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      installStore.set(event as InstallPromptEvent);
    };
    const onInstalled = () => installStore.markInstalled();
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return null;
}
