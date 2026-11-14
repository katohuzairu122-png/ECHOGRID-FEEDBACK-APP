'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { installStore } from './install-store';

function isStandalone() {
  return (
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

interface Copy {
  button: string;
  installed: string;
  ios: string;
  manual: string;
}

/**
 * The install control for the "This device" screen. It states what is true on THIS device: already installed, an
 * install button when the browser has offered one, the iPhone steps on iOS, and otherwise plain manual steps. It never
 * claims the browser cannot install apps, because a missing prompt does not mean that.
 */
export function CashierInstall({ copy }: { copy: Copy }) {
  const prompt = useSyncExternalStore(installStore.subscribe, installStore.get, () => null);
  const wasInstalled = useSyncExternalStore(installStore.subscribe, installStore.isInstalled, () => false);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  useEffect(() => {
    setStandalone(isStandalone());
    setIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  if (standalone || wasInstalled) return <p className="text-sm text-neutral-600">{copy.installed}</p>;
  return (
    <div className="space-y-2">
      {prompt && (
        <Button
          type="button"
          className="min-h-12 w-full"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice;
            installStore.set(null);
          }}
        >
          {copy.button}
        </Button>
      )}
      <p className="text-sm text-neutral-600">{ios ? copy.ios : copy.manual}</p>
    </div>
  );
}
