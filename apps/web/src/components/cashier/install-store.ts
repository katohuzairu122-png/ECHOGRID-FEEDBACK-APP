/**
 * CASHIER-PWA-DEPLOY-01: holds the browser's one-shot `beforeinstallprompt` event. The browser fires it once, early in
 * the page's life. The install control lives on the "This device" screen, which a cashier usually reaches by in-app
 * navigation long after the event fired, so a listener added only on that screen never sees it (found on the first
 * phone test: the screen claimed the browser cannot install). The capture component below is mounted for every cashier
 * page and keeps the event here for the install control to use later.
 */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const installStore = {
  get: () => deferred,
  isInstalled: () => installed,
  set(event: InstallPromptEvent | null) {
    deferred = event;
    notify();
  },
  markInstalled() {
    installed = true;
    deferred = null;
    notify();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
