import { ResultBook, createJournal, exitCodeFor, writeReport, findInterruptedRuns, type RunReport, type RunState } from './result';
import { HarnessRefusal } from './guard';
import { redactString } from './redact';
import { SCENARIOS, buildWorld, type Context, type Recorder, type Scenario } from './scenarios';

export interface RunOptions {
  ctx: Context;
  mode: string;
  commit: string;
  outDir?: string | undefined;
  only?: string[] | undefined;
  /** Test hook: runs after each scenario (used to simulate an interruption). */
  afterScenario?: ((id: string) => void | Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
}

export interface RunOutcome {
  report: RunReport;
  file: string | null;
  interruptedEarlier: string[];
}

/**
 * Runs the scenarios in a fixed order. A scenario that throws becomes a FAIL, never a crash, and the run continues. If the whole run
 * is interrupted (a signal or an unexpected error) the evidence so far is already in the journal and a final report with state
 * INTERRUPTED is written. A run never reuses or deletes the files of an earlier run.
 */
export async function runAcceptance(opts: RunOptions): Promise<RunOutcome> {
  const { ctx } = opts;
  const interruptedEarlier = opts.outDir ? await findInterruptedRuns(opts.outDir) : [];
  const journal = opts.outDir ? createJournal(opts.outDir, ctx.runId) : undefined;
  const book = new ResultBook({ runId: ctx.runId, mode: opts.mode, commit: opts.commit }, journal);
  const selected: Scenario[] = SCENARIOS.filter((s) => !opts.only || opts.only.includes(s.id));
  let state: RunState = 'COMPLETE';
  let current = '';
  const recFor = (scenarioId: string): Recorder => ({
    check: (id, title, ok, detail) => book.add(scenarioId, id, title, ok ? 'PASS' : 'FAIL', detail ?? ''),
    notRun: (id, title, reason) => book.add(scenarioId, id, title, 'NOT_RUN', reason),
  });
  try {
    let world: Awaited<ReturnType<typeof buildWorld>> | null = null;
    let setupError = '';
    try {
      world = await buildWorld(ctx);
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'setup failed';
      await book.add('SETUP', 'SETUP.1', 'owner sign-in and fixture discovery', 'FAIL', setupError);
    }
    const runOne = async (scenario: Scenario): Promise<void> => {
      const rec = recFor(scenario.id);
      if (!world) {
        await rec.notRun(`${scenario.id}.0`, scenario.title, `setup failed: ${redactString(setupError)}`);
        return;
      }
      const unavailable = scenario.unavailable?.(ctx, world) ?? null;
      if (unavailable) {
        await rec.notRun(`${scenario.id}.0`, scenario.title, unavailable);
        return;
      }
      try {
        await scenario.run(ctx, world, rec);
      } catch (error) {
        if (error instanceof HarnessRefusal) throw error;
        await rec.check(`${scenario.id}.error`, `${scenario.title} (unexpected error)`, false, error instanceof Error ? `${error.name}: ${error.message}` : 'unexpected error');
      }
    };
    for (const scenario of selected) {
      if (opts.signal?.aborted) { state = 'INTERRUPTED'; break; }
      current = scenario.id;
      await runOne(scenario);
      await opts.afterScenario?.(scenario.id);
    }
  } catch (error) {
    state = error instanceof HarnessRefusal ? 'BLOCKED' : 'INTERRUPTED';
    await book.add(current || 'RUN', `${current || 'RUN'}.stop`, 'run stopped', 'FAIL', error instanceof Error ? redactString(error.message) : 'stopped');
  }
  const report = book.finalize(state);
  const file = opts.outDir ? await writeReport(opts.outDir, report) : null;
  return { report, file, interruptedEarlier };
}

export { exitCodeFor };
