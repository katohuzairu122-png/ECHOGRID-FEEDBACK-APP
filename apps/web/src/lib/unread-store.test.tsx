import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  resetUnreadStoreForTests,
  useUnreadCount,
  type UnreadSource,
} from './unread-store';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

function Probe({ source, id }: { source: UnreadSource; id: string }) {
  return <p data-testid={id}>{useUnreadCount(source)}</p>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let visibility: 'visible' | 'hidden';
const setAppBadge = vi.fn(async () => undefined);
const clearAppBadge = vi.fn(async () => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => json({ unreadMessages: 3 }));
  vi.stubGlobal('fetch', fetchMock);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.assign(navigator, { setAppBadge, clearAppBadge });
  document.title = 'Echo Grid';
  setAppBadge.mockClear();
  clearAppBadge.mockClear();
});

afterEach(() => {
  resetUnreadStoreForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('unread store', () => {
  it('shows the count from the endpoint for its source', async () => {
    render(<Probe source="staff-messages" id="a" />);
    await flush();
    expect(screen.getByTestId('a')).toHaveTextContent('3');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/messaging/unread',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('uses the customer endpoint for the customer source', async () => {
    render(<Probe source="customer-messages" id="a" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/loyalty/unread', expect.anything());
  });

  it('makes one request however many badges are on screen (sidebar, bottom bar, sheet)', async () => {
    render(
      <>
        <Probe source="staff-messages" id="a" />
        <Probe source="staff-messages" id="b" />
        <Probe source="staff-messages" id="c" />
      </>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const id of ['a', 'b', 'c']) expect(screen.getByTestId(id)).toHaveTextContent('3');
  });

  it('does not refetch or resubscribe when the component re-renders', async () => {
    function Rerender() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>again {n}</button>
          <Probe source="staff-messages" id="a" />
        </>
      );
    }
    render(<Rerender />);
    await flush();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => screen.getByRole('button').click());
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes every 45 seconds while the tab is visible and not while it is hidden', async () => {
    render(<Probe source="staff-messages" id="a" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility = 'hidden';
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes straight away when the tab becomes visible again', async () => {
    render(<Probe source="staff-messages" id="a" />);
    await flush();
    fetchMock.mockResolvedValueOnce(json({ unreadMessages: 7 }));
    visibility = 'hidden';
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('a')).toHaveTextContent('7');
  });

  it('treats a failed or non-JSON answer as zero and backs the interval off, up to a cap', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<html>sign in</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    render(<Probe source="staff-messages" id="a" />);
    await flush();
    expect(screen.getByTestId('a')).toHaveTextContent('0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The first timer was armed before the first failure, so the first retry is at the base interval.
    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // After that the wait grows (180 s here): nothing at +90 s, next call at +180 s.
    await advance(POLL_INTERVAL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(POLL_INTERVAL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 8; i += 1) await advance(MAX_BACKOFF_MS);
    const calls = fetchMock.mock.calls.length;
    await advance(MAX_BACKOFF_MS);
    expect(fetchMock.mock.calls.length).toBe(calls + 1); // never slower than the cap
  });

  it('treats a 429 or 500 as zero without throwing', async () => {
    fetchMock.mockResolvedValue(json({ unreadMessages: 9 }, { status: 429 }));
    render(<Probe source="staff-messages" id="a" />);
    await flush();
    expect(screen.getByTestId('a')).toHaveTextContent('0');
  });

  it('puts the count in the tab title and the app icon badge, and removes both at zero', async () => {
    const { unmount } = render(<Probe source="staff-messages" id="a" />);
    await flush();
    expect(document.title).toBe('(3) Echo Grid');
    expect(setAppBadge).toHaveBeenLastCalledWith(3);
    fetchMock.mockResolvedValue(json({ unreadMessages: 0 }));
    await advance(POLL_INTERVAL_MS);
    expect(document.title).toBe('Echo Grid');
    expect(clearAppBadge).toHaveBeenCalled();
    fetchMock.mockResolvedValue(json({ unreadMessages: 120 }));
    await advance(POLL_INTERVAL_MS);
    expect(document.title).toBe('(99+) Echo Grid');
    unmount();
    expect(document.title).toBe('Echo Grid');
  });

  it('stops polling when the last badge goes away', async () => {
    const { unmount } = render(<Probe source="staff-messages" id="a" />);
    await flush();
    unmount();
    await advance(POLL_INTERVAL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the two sources independent', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json({ unreadMessages: url.includes('messaging') ? 2 : 5 }),
    );
    render(
      <>
        <Probe source="staff-messages" id="staff" />
        <Probe source="customer-messages" id="customer" />
      </>,
    );
    await flush();
    expect(screen.getByTestId('staff')).toHaveTextContent('2');
    expect(screen.getByTestId('customer')).toHaveTextContent('5');
  });
});
