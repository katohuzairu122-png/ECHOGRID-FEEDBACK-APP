'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isStandalone() {
  return (
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

export function PwaInstallButton({
  label,
  iosHint,
  className,
}: {
  label: string;
  iosHint: string;
  className?: string;
}) {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;

    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (ios) setShowIosHelp(true);

    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const installed = () => {
      setInstallPrompt(null);
      setShowIosHelp(false);
    };

    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  if (!installPrompt && !showIosHelp) return null;

  const install = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
      return;
    }
    window.alert(iosHint);
  };

  return (
    <Button type="button" variant="ghost" size="sm" className={className} onClick={install}>
      {label}
    </Button>
  );
}
