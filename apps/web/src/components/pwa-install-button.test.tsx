import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PwaInstallButton } from './pwa-install-button';

describe('PwaInstallButton', () => {
  it('shows the captured browser install prompt when selected', async () => {
    const prompt = vi.fn(async () => undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: typeof prompt;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    render(<PwaInstallButton label="Install app" iosHint="Use Add to Home Screen" />);
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();

    act(() => window.dispatchEvent(event));
    fireEvent.click(screen.getByRole('button', { name: 'Install app' }));

    expect(prompt).toHaveBeenCalledOnce();
  });
});
