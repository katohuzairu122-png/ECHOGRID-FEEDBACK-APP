import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyOps, alertOnFailure, OPS_ALERT_SERVICE } from './ops-alert';

/**
 * The properties that make this path safe to call from inside a failure
 * handler: it always leaves a log line, it never throws, and it never
 * depends on the webhook being configured or reachable.
 *
 * Those are exactly the properties an alerting path gets wrong, and getting
 * them wrong turns one incident into two -- a cron sweep that failed, plus
 * an unhandled rejection from the code reporting it.
 */
describe('notifyOps', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const ENV_WITHOUT_WEBHOOK = {
    ENVIRONMENT: 'production' as const,
    OPS_ALERT_WEBHOOK_URL: undefined,
  };
  const ENV_WITH_WEBHOOK = {
    ENVIRONMENT: 'production' as const,
    OPS_ALERT_WEBHOOK_URL: 'https://hooks.example.test/abc',
  };

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it('logs the alert even when no webhook is configured, and makes no request', async () => {
    // The unconfigured case is the DEFAULT state -- OPS_ALERT_WEBHOOK_URL is
    // an optional secret. If this path logged nothing, adding these call
    // sites would have made the platform quieter, not louder.
    await notifyOps(ENV_WITHOUT_WEBHOOK, {
      event: 'queue.dead_letter',
      severity: 'critical',
      message: 'A job reached the dead-letter queue.',
    });

    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain('A job reached the dead-letter queue.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs first AND posts when a webhook is configured', async () => {
    await notifyOps(ENV_WITH_WEBHOOK, {
      event: 'cron.sweep_failed',
      severity: 'warning',
      message: 'The escalation sweep failed.',
    });

    expect(consoleError).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hooks.example.test/abc');
  });

  it('sends a payload that Slack, Discord and a structured consumer can all read', async () => {
    await notifyOps(ENV_WITH_WEBHOOK, {
      event: 'queue.dead_letter',
      severity: 'critical',
      message: 'A job reached the dead-letter queue.',
      detail: { jobType: 'generate_summary', attempts: 4 },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));

    // Slack renders `text`; Discord renders `content`. Both present so the
    // same secret works for either without a config switch.
    expect(body.text).toContain('A job reached the dead-letter queue.');
    expect(body.content).toBe(body.text);
    expect(body.text).toContain('[critical]');
    expect(body.text).toContain(OPS_ALERT_SERVICE);
    expect(body.text).toContain('production');

    // And the structured fields a vendor endpoint groups on.
    expect(body.event).toBe('queue.dead_letter');
    expect(body.severity).toBe('critical');
    expect(body.environment).toBe('production');
    expect(body.detail).toEqual({ jobType: 'generate_summary', attempts: 4 });
    expect(typeof body.timestamp).toBe('string');
  });

  it('does not throw when the webhook request rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      notifyOps(ENV_WITH_WEBHOOK, { event: 'x', severity: 'warning', message: 'm' }),
    ).resolves.toBeUndefined();

    // Two lines: the alert itself, then the delivery failure.
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(String(consoleError.mock.calls[1]?.[0])).toContain('delivery failed');
  });

  it('does not throw, or retry, on a non-2xx response', async () => {
    // A 404 from the destination is a config problem for a human to see in
    // its own dashboard. Escalating from inside an alerting path is how one
    // incident becomes two.
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));

    await expect(
      notifyOps(ENV_WITH_WEBHOOK, { event: 'x', severity: 'warning', message: 'm' }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('omits detail as an empty object rather than undefined', async () => {
    await notifyOps(ENV_WITH_WEBHOOK, { event: 'x', severity: 'warning', message: 'm' });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.detail).toEqual({});
  });
});

describe('alertOnFailure', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  const ENV = { ENVIRONMENT: 'production' as const, OPS_ALERT_WEBHOOK_URL: undefined };

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  it('returns the value and alerts nobody when the work succeeds', async () => {
    const result = await alertOnFailure(ENV, { event: 'cron.x', severity: 'warning', message: 'm' }, async () => 42);

    expect(result).toBe(42);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('swallows the rejection, alerts, and resolves undefined', async () => {
    // The point for a ctx.waitUntil() caller: a rejected promise handed to
    // waitUntil is an unhandled rejection -- unattributed in the log and
    // notified to nobody, which is how the cron sweeps failed silently.
    const result = await alertOnFailure(
      ENV,
      { event: 'cron.sweep_failed', severity: 'critical', message: 'The sweep failed.' },
      async () => {
        throw new Error('database unreachable');
      },
    );

    expect(result).toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("folds the error message into detail, keeping the caller's own fields", async () => {
    await alertOnFailure(
      ENV,
      { event: 'cron.sweep_failed', severity: 'critical', message: 'm', detail: { cron: '*/5 * * * *' } },
      async () => {
        throw new Error('database unreachable');
      },
    );

    expect(consoleError.mock.calls[0]?.[1]).toEqual({
      cron: '*/5 * * * *',
      error: 'database unreachable',
    });
  });

  it('stringifies a non-Error throw rather than losing it', async () => {
    await alertOnFailure(ENV, { event: 'x', severity: 'warning', message: 'm' }, async () => {
      // A bare string is legal to throw and `err instanceof Error` is false
      // for it, which is the branch under test. No eslint directive needed:
      // only-throw-error lives in recommended-type-checked, which this
      // config does not extend, and an unused directive is itself a warning.
      throw 'a bare string';
    });

    expect(consoleError.mock.calls[0]?.[1]).toEqual({ error: 'a bare string' });
  });
});
