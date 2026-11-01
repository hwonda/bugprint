import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateTest, selectSteps, type GenerateOptions } from '../codegen/test.js';
import type { Flow, Step } from '../flow/extract.js';
import { describeStep } from '../flow/summarize.js';
import { verifyTests, type VerifyResult } from '../verify/run.js';

/**
 * Finds a much shorter test that still fails with the recorded error.
 *
 *  1. Baseline: the full test must be "reproduced".
 *  2. Start point: try opening each later page directly (skipping everything
 *     before it) and keep the latest one that still reproduces.
 *  3. Delta debugging (ddmin) over the remaining steps.
 *
 * Every round's candidates are written as separate files and run in a single
 * test-runner invocation with parallel workers, so a round costs one app
 * start-up instead of one per candidate.
 */

export interface MinimizeOptions extends Omit<GenerateOptions, 'includeSteps' | 'excludeSteps' | 'startFrom' | 'fixturesFile'> {
  cwd?: string;
  workers?: number;
  /** Per round. Default 180000. */
  timeoutMs?: number;
  /** Stop after this many runner invocations. Default 12. */
  maxRounds?: number;
  onProgress?: (message: string, round: number) => void;
}

export interface Candidate {
  startFrom: string | null;
  include: string[];
}

export interface MinimizeResult {
  verdict: 'minimized' | 'already-minimal' | 'not-reproduced' | 'error';
  summary: string;
  baseline: VerifyResult;
  original: { steps: number };
  minimal: { startFrom: string | null; includeSteps: string[]; steps: number; description: string[] } | null;
  removed: string[];
  rounds: number;
  testsRun: number;
  durationMs: number;
  /** The minimal test, ready to write. */
  code: string | null;
}

const NAV = new Set<Step['kind']>(['goto', 'expectUrl', 'reload', 'back', 'forward']);

export async function minimizeRepro(flow: Flow, opts: MinimizeOptions = {}): Promise<MinimizeResult> {
  const started = Date.now();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const maxRounds = opts.maxRounds ?? 12;
  // Candidate files must live inside the project so they can import the test runner.
  await mkdir(path.join(cwd, '.bugprint'), { recursive: true });
  const work = await mkdtemp(path.join(cwd, '.bugprint', 'minimize-'));
  const cache = new Map<string, VerifyResult>();
  let rounds = 0;
  let testsRun = 0;

  const genOpts: GenerateOptions = { ...opts };
  const key = (c: Candidate) => `${c.startFrom ?? ''}|${c.include.join(',')}`;

  /** Runs all not-yet-seen candidates in one batch. */
  async function run(cands: Candidate[], label: string): Promise<VerifyResult[]> {
    const fresh = [...new Map(cands.filter((c) => !cache.has(key(c))).map((c) => [key(c), c])).values()];
    if (fresh.length) {
      rounds++;
      opts.onProgress?.(`round ${rounds}: ${label} (${fresh.length} candidate${fresh.length > 1 ? 's' : ''})`, rounds);
      const dir = path.join(work, `r${rounds}`);
      await mkdir(dir);
      const files: string[] = [];
      for (const [i, c] of fresh.entries()) {
        const file = path.join(dir, `c${i}.spec.ts`);
        const { code } = generateTest(flow, { ...genOpts, startFrom: c.startFrom ?? undefined, includeSteps: c.include, testName: `candidate ${i}` });
        await writeFile(file, code);
        files.push(file);
      }
      const results = await verifyTests(files, { cwd, baseUrl: opts.baseUrl, workers: opts.workers, timeoutMs: opts.timeoutMs });
      testsRun += fresh.length;
      fresh.forEach((c, i) => cache.set(key(c), results[i]!));
    }
    return cands.map((c) => cache.get(key(c))!);
  }
  const ok = (r: VerifyResult) => r.verdict === 'reproduced';

  try {
    const all = flow.steps;
    const first = all[0];
    const pinnedFirst = first?.kind === 'goto' ? first.id : null;
    const baselineCand: Candidate = { startFrom: null, include: all.map((s) => s.id) };
    const [baseline] = await run([baselineCand], 'baseline: the full test');
    if (!baseline || !ok(baseline)) {
      return done(baseline?.verdict === 'error' ? 'error' : 'not-reproduced', `The full test does not reproduce the bug (verdict: ${baseline?.verdict}). Fix that first with run_and_verify.`, baseline!, null);
    }

    // ---- 2. latest start page that still reproduces ------------------------------
    let startFrom: string | null = null;
    let rest = all.filter((s) => s.id !== pinnedFirst).map((s) => s.id);
    const starts = all.slice(1).filter((s) => NAV.has(s.kind));
    if (starts.length) {
      const cands = starts.map((s) => ({ startFrom: s.id, include: after(s.id) }));
      const results = await run(cands, 'open later pages directly');
      for (let i = starts.length - 1; i >= 0; i--) {
        if (ok(results[i]!)) {
          startFrom = starts[i]!.id;
          rest = after(startFrom);
          break;
        }
      }
    }
    const make = (subset: string[]): Candidate => ({ startFrom, include: startFrom ? subset : [...(pinnedFirst ? [pinnedFirst] : []), ...subset] });

    // ---- 3. ddmin over the remaining steps ---------------------------------------
    let c = rest;
    if (c.length && rounds < maxRounds) {
      const [empty] = await run([make([])], 'no steps after opening the page');
      if (ok(empty!)) c = [];
    }
    let n = 2;
    while (c.length >= 2 && rounds < maxRounds) {
      const chunks = split(c, n);
      const complements = n > 2 ? chunks.map((ch) => c.filter((x) => !ch.includes(x))) : [];
      const cands = [...chunks, ...complements].map(make);
      const results = await run(cands, `ddmin: ${c.length} steps in ${n} chunks`);
      const subIdx = chunks.map((_, i) => i).filter((i) => ok(results[i]!)).sort((a, b) => chunks[a]!.length - chunks[b]!.length)[0];
      if (subIdx !== undefined) {
        c = chunks[subIdx]!;
        n = 2;
        continue;
      }
      const compIdx = complements.findIndex((_, i) => ok(results[chunks.length + i]!));
      if (compIdx !== -1) {
        c = complements[compIdx]!;
        n = Math.max(n - 1, 2);
        continue;
      }
      if (n >= c.length) break;
      n = Math.min(c.length, n * 2);
    }

    const final = make(c);
    const finalResult = cache.get(key(final)) ?? (await run([final], 'confirm the minimal test'))[0]!;
    if (!ok(finalResult)) {
      // Should not happen (every accepted candidate reproduced), but never return an unverified test.
      return done('error', 'The minimal candidate did not reproduce on its own run; the bug may be flaky.', baseline, null);
    }
    const minimalSteps = selectSteps(flow, { startFrom: final.startFrom ?? undefined, includeSteps: final.include });
    const keptIds = new Set(minimalSteps.map((s) => s.id));
    const removed = all.filter((s) => !keptIds.has(s.id)).map((s) => `${s.id} · ${describeStep(s)}`);
    const { code } = generateTest(flow, { ...genOpts, startFrom: final.startFrom ?? undefined, includeSteps: final.include });
    const minimal = {
      startFrom: final.startFrom,
      includeSteps: final.include,
      steps: minimalSteps.length,
      description: minimalSteps.map((s) => `${s.id} · ${describeStep(s.id === final.startFrom ? { ...s, kind: 'goto' } : s)}`),
    };
    const verdict = removed.length ? 'minimized' : 'already-minimal';
    const summary = removed.length
      ? `Reduced ${all.length} steps to ${minimalSteps.length}; the shorter test still fails with the recorded error.`
      : 'Every step is needed to reproduce the bug.';
    return done(verdict, summary, baseline, minimal, removed, code);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  function after(id: string): string[] {
    const i = flow.steps.findIndex((s) => s.id === id);
    return flow.steps.slice(i + 1).map((s) => s.id);
  }

  function done(
    verdict: MinimizeResult['verdict'],
    summary: string,
    baseline: VerifyResult,
    minimal: MinimizeResult['minimal'],
    removed: string[] = [],
    code: string | null = null,
  ): MinimizeResult {
    return { verdict, summary, baseline, original: { steps: flow.steps.length }, minimal, removed, rounds, testsRun, durationMs: Date.now() - started, code };
  }
}

export function split<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  const size = Math.ceil(items.length / n);
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
