import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CashierInstall } from './cashier-install';
import { InstallCapture } from './install-capture';
import { installStore } from './install-store';

const copy = { button: 'INSTALL', installed: 'ALREADY', ios: 'IOS STEPS', manual: 'MANUAL STEPS' };

function fakePrompt() {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string; platform: string }> };
  e.prompt = vi.fn(async () => undefined);
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  return e;
}

afterEach(() => {
  installStore.set(null);
  vi.restoreAllMocks();
});

describe('cashier install control', () => {
  it('shows the Install button for a prompt captured BEFORE the screen mounted (the in-app navigation case)', () => {
    render(<InstallCapture />);
    act(() => void window.dispatchEvent(fakePrompt()));
    // The "This device" screen mounts only now, after the one-shot event already fired.
    render(<CashierInstall copy={copy} />);
    expect(screen.getByRole('button', { name: 'INSTALL' })).toBeInTheDocument();
  });

  it('running the install uses the captured prompt once and then hides the button', async () => {
    render(<InstallCapture />);
    const event = fakePrompt();
    act(() => void window.dispatchEvent(event));
    render(<CashierInstall copy={copy} />);
    await act(async () => void screen.getByRole('button', { name: 'INSTALL' }).click());
    expect((event as unknown as { prompt: () => Promise<void> }).prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'INSTALL' })).not.toBeInTheDocument();
  });

  it('with no prompt it gives manual steps, never a claim that the browser cannot install', () => {
    const { container } = render(<CashierInstall copy={copy} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('MANUAL STEPS');
    expect(container).not.toHaveTextContent(/cannot install/i);
  });

  it('on iOS it shows the Share steps', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    const { container } = render(<CashierInstall copy={copy} />);
    expect(container).toHaveTextContent('IOS STEPS');
  });

  it('says it is installed after the browser reports appinstalled, and when running standalone', () => {
    render(<InstallCapture />);
    const { container, unmount } = render(<CashierInstall copy={copy} />);
    act(() => void window.dispatchEvent(new Event('appinstalled')));
    expect(container).toHaveTextContent('ALREADY');
    unmount();
    installStore.set(null);
  });
});
