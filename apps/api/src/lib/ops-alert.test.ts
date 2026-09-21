import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyOps, alertOnFailure, extractSafeDiagnostics, OPS_ALERT_SERVICE } from './ops-alert';

/**
 * Mimics node-postgres's DatabaseError shape without pulling in `pg` --
 * own enumerable string properties, no getters, matching what
 * pg-protocol's parser.js actually assigns (Block 1B investigation).
 */
class FakeDatabaseError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  schema?: string;
  table?: string;
  column?: string;
  constructor(message: string, fields: Partial<FakeDatabaseError> = {}) {
    super(message);
    this.name = 'error';
    Object.assign(this, fields);
  }
}

/** Mimics drizzle-orm's DrizzleQueryError (drizzle-orm/errors.js): its own
 * `.message` embeds the query AND bound parameter values, and the real
 * driver error rides on `.cause`. */
class FakeDrizzleQueryError extends Error {
  query: string;
  params: unknown;
  constructor(query: string, params: unknown, cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params}`);
    this.query = query;
    this.params = params;
    this.cause = cause;
  }
}

/**
 * The properties that make this path safe to call from inside a failure
 * handler: it always leaves a log line, it never throws, and it never
 * depends on the webhook being configured or reachable.
 *
 * Those are exactly the properties an alerting path gets wrong, and getting
 * them wrong turns one incident into two -- a cron sweep that failed, plus
 * an unhandled rejection from the code reporting it.
 */
describe('extractSafeDiagnostics', () => {
  it('returns undefined for a normal Error with no cause', () => {
    // The common case -- most throws in this codebase are plain Errors.
    // Nothing to add beyond the message the caller already logs separately.
    expect(extractSafeDiagnostics(new Error('database unreachable'))).toBeUndefined();
  });

  it('returns undefined for a non-Error throw', () => {
    expect(extractSafeDiagnostics('a bare string')).toBeUndefined();
    expect(extractSafeDiagnostics({ code: '23505' })).toBeUndefined();
  });

  it('extracts name and message from a plain Error cause', () => {
    const err = new Error('outer wrapper', { cause: new Error('inner reason') });
    expect(extractSafeDiagnostics(err)).toEqual({ name: 'Error', message: 'inner reason' });
  });

  it('extracts SQLSTATE/constraint/schema/table from a database-like cause', () => {
    // The exact shape Block 1B found: DrizzleQueryError wrapping the real
    // driver error on .cause.
    const dbError = new FakeDatabaseError('duplicate key value violates unique constraint "ai_usage_log_pkey"', {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
      constraint: 'ai_usage_log_pkey',
      schema: 'public',
      table: 'ai_usage_log',
    });
    const wrapped = new FakeDrizzleQueryError(
      'update "ai_usage_log" set "status" = $1 where "status" = $2',
      'abandoned,pending',
      dbError,
    );

    expect(extractSafeDiagnostics(wrapped)).toEqual({
      name: 'error',
      message: 'duplicate key value violates unique constraint "ai_usage_log_pkey"',
      code: '23505',
      constraint: 'ai_usage_log_pkey',
      schema: 'public',
      table: 'ai_usage_log',
      // detail is set on dbError above (deliberately, see the next test) yet
      // must not appear here: hint/column/detail all omitted -- hint/column
      // because FakeDatabaseError never set them, detail because it is not
      // in SAFE_DIAGNOSTIC_KEYS at all, regardless of whether it's present.
    });
  });

  it('never emits detail or hint, even when the cause carries real-looking sensitive values', () => {
    // The user-directed hardening this test locks in: PostgreSQL's own
    // `detail`/`hint` fields are free text Postgres composes from the
    // actual row/key data in the failure -- a unique-violation's `detail`
    // routinely echoes the conflicting value back verbatim. Both fields are
    // excluded from SAFE_DIAGNOSTIC_KEYS entirely, not filtered by content,
    // so this holds regardless of what they contain.
    const dbError = new FakeDatabaseError('duplicate key value violates unique constraint "users_email_key"', {
      code: '23505',
      detail: 'Key (email)=(customer@example.com) already exists.',
      hint: 'Sensitive example value',
      constraint: 'users_email_key',
      schema: 'public',
      table: 'users',
    });
    const wrapped = new FakeDrizzleQueryError('insert into "users" ("email") values ($1)', 'customer@example.com', dbError);

    const result = extractSafeDiagnostics(wrapped);
    expect(result).toEqual({
      name: 'error',
      message: 'duplicate key value violates unique constraint "users_email_key"',
      code: '23505',
      constraint: 'users_email_key',
      schema: 'public',
      table: 'users',
    });
    expect(result).not.toHaveProperty('detail');
    expect(result).not.toHaveProperty('hint');
    expect(JSON.stringify(result)).not.toContain('customer@example.com');
    expect(JSON.stringify(result)).not.toContain('Sensitive example value');
  });

  it('never emits unapproved properties, even when the cause carries them', () => {
    class SuspiciousCause extends Error {
      code = '08006';
      // None of these are in the whitelist and must never appear in output,
      // however sensitive-looking or ordinary they are.
      connectionString = 'postgresql://user:hunter2@host/db';
      authorization = 'Bearer secret-token';
      stack_override_attempt = 'not real, just checking key-by-key extraction';
      requestBody = { email: 'customer@example.com' };
    }
    const err = new Error('outer', { cause: new SuspiciousCause('connection terminated') });

    const result = extractSafeDiagnostics(err);
    expect(result).toEqual({ name: 'Error', message: 'connection terminated', code: '08006' });
    expect(result).not.toHaveProperty('connectionString');
    expect(result).not.toHaveProperty('authorization');
    expect(result).not.toHaveProperty('requestBody');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('stops at a bounded depth rather than looping on a circular cause chain', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a; // circular
    expect(() => extractSafeDiagnostics(a)).not.toThrow();
  });
});

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

  it('strips bound parameter values from a DrizzleQueryError-shaped message, keeping the query text', async () => {
    // Block 1B: drizzle-orm's own wrapper message is "Failed query:
    // <sql>\nparams: <values>" -- the values can be anything a query binds,
    // including customer content. Only the SQL shape should survive.
    await alertOnFailure(
      ENV,
      { event: 'cron.stale_ai_usage_sweep_failed', severity: 'warning', message: 'm' },
      async () => {
        throw new FakeDrizzleQueryError(
          'update "ai_usage_log" set "status" = $1 where "status" = $2',
          'abandoned,customer@example.com',
          new FakeDatabaseError('column "status" is of type text but expression is of type integer', {
            code: '42804',
          }),
        );
      },
    );

    const detail = consoleError.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail.error).toBe('Failed query: update "ai_usage_log" set "status" = $1 where "status" = $2');
    expect(JSON.stringify(detail)).not.toContain('customer@example.com');
    expect(detail.cause).toEqual({
      name: 'error',
      message: 'column "status" is of type text but expression is of type integer',
      code: '42804',
    });
  });

  it('includes cause diagnostics only when the thrown error actually has one', async () => {
    await alertOnFailure(ENV, { event: 'cron.x', severity: 'warning', message: 'm' }, async () => {
      throw new Error('plain failure, no cause');
    });

    const detail = consoleError.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail).toEqual({ error: 'plain failure, no cause' });
    expect(detail).not.toHaveProperty('cause');
  });
});
