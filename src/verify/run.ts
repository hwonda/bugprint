import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERRORS_ANNOTATION, META_PREFIX, type TestMeta } from '../codegen/test.js';
import { sweepStale, trackChild, trackPath } from '../util/cleanup.js';

export type Verdict =
  /** Failed, and the failure contains the error recorded in the session. */
  | 'reproduced'
  /** Failed for another reason (a locator timed out, a different error...). */
  | 'failed-differently'
  /** Failed, but the recording had no error to compare with. */
  | 'failed'
  /** Passed: either the bug is fixed, or the test does not reproduce it. */
  | 'passed'
  /** The runner itself could not run the test (missing dependency, config error...). */
  | 'error';

export interface VerifyOptions {
  cwd?: string;
  /** Exported to the test as BUGPRINT_BASE_URL. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Run every project of the user's config instead of only the first one. */
  allProjects?: boolean;
  /** Errors to look for; defaults to the ones embedded in the generated test. */
  expectedErrors?: string[];
  /** Test runner config to use. Default: the nearest playwright.config.* above the test file. */
  config?: string;
  /** The verdict you expect; sets `ok` on the result (and the CLI exit code). */
  expect?: Verdict;
}

export interface VerifyResult {
  verdict: Verdict;
  summary: string;
  durationMs: number;
  failedStep?: { id: string; description: string; line: number };
  error?: string;
  recordedErrors: string[];
  matchedError?: string;
  command: string;
  /** Present when `expect` was given: whether the verdict matched it. */
  ok?: boolean;
}

const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];
const WRAPPER_PREFIX = '.bugprint-run-';

/** Nearest runner config at or above `from` (works in monorepos where tests live in a package). */
export function findConfig(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    const hit = CONFIG_NAMES.map((n) => path.join(dir, n)).find((p) => existsSync(p));
    if (hit) return hit;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Resolves the runner's CLI entry so we can start it as `node cli.js`. This avoids
 * shell shims (`.bin/playwright.cmd` cannot be spawned without a shell on Windows).
 */
export function findRunnerCli(from: string): string | null {
  const req = createRequire(path.join(path.resolve(from), 'noop.js'));
  for (const id of ['@playwright/test/cli', 'playwright/cli']) {
    try {
      return req.resolve(id);
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function verifyTest(testPath: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const [r] = await verifyTests([testPath], opts);
  return r!;
}

export interface BatchOptions extends VerifyOptions {
  /** Parallel workers for a batch. Default 1 for a single file, otherwise 4. */
  workers?: number;
}

/**
 * Runs several generated tests in ONE runner invocation (one webServer start,
 * parallel workers) and returns a verdict per file, in input order.
 * All files must live in the same directory.
 */
export async function verifyTests(testPaths: string[], opts: BatchOptions = {}): Promise<VerifyResult[]> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const files = testPaths.map((p) => path.resolve(cwd, p));
  if (!files.length) return [];
  const dir = path.dirname(files[0]!);
  if (files.some((f) => path.dirname(f) !== dir)) throw new Error('verifyTests: all files must be in the same directory.');
  const sources = await Promise.all(files.map((f) => readFile(f, 'utf8')));
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const userConfig = opts.config ? path.resolve(cwd, opts.config) : findConfig(dir);
  if (opts.config && !existsSync(userConfig!)) {
    return files.map((_, i) => makeResult(i, 'error', `Config not found: ${userConfig}`));
  }
  // Run from the config's directory, like the runner itself would.
  const runDir = userConfig ? path.dirname(userConfig) : cwd;
  const cli = findRunnerCli(runDir) ?? findRunnerCli(dir);
  let command = '';
  const all = (verdict: Verdict, summary: string, error?: string) => files.map((_, i) => makeResult(i, verdict, summary, error));
  if (!cli) {
    return all(
      'error',
      'The test runner is not installed in this project. Run: npm i -D @playwright/test && npx playwright install chromium',
    );
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'bugprint-run-'));
  const releaseTmp = trackPath(tmp);
  const reportFile = path.join(tmp, 'report.json');
  // The wrapper must sit next to the user's config: relative paths in it (webServer.cwd,
  // globalSetup, outputDir...) are resolved against the config file's directory.
  // A TypeScript config needs a TypeScript wrapper; for any JS flavour (.js/.cjs/.mjs) an ES module
  // wrapper can import it (an ESM wrapper named .cjs or .js in a CommonJS package would not load).
  const ext = userConfig?.endsWith('.ts') ? '.ts' : '.mjs';
  const wrapperDir = userConfig ? path.dirname(userConfig) : tmp;
  sweepStale(wrapperDir, WRAPPER_PREFIX);
  const wrapper = path.join(wrapperDir, `${WRAPPER_PREFIX}${process.pid}-${Date.now()}.config${ext}`);
  const releaseWrapper = trackPath(wrapper);
  const workers = opts.workers ?? (files.length > 1 ? 4 : 1);
  await writeFile(
    wrapper,
    wrapperConfig(
      userConfig,
      dir,
      files.map((f) => path.basename(f)),
      opts.allProjects ?? false,
      workers,
    ),
    'utf8',
  );

  const args = ['test', '--config', wrapper, '--reporter', 'json'];
  command = `node ${path.relative(runDir, cli)} ${args.join(' ')}`;
  try {
    const run = await exec(process.execPath, [cli, ...args], {
      cwd: runDir,
      timeoutMs,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
        FORCE_COLOR: '0',
        ...(opts.baseUrl ? { BUGPRINT_BASE_URL: opts.baseUrl } : {}),
      },
    });
    if (run.timedOut) {
      const silent = !run.stdout.trim() && !run.stderr.trim();
      return all(
        'error',
        `The run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.` +
          (silent
            ? ' The runner printed nothing at all, so it probably never started: old runner releases can hang on newer Node versions (seen with 1.45 on Node 24). Try a newer @playwright/test or an older Node.'
            : ''),
        tail(run.stderr || run.stdout),
      );
    }
    let report: Report;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8'));
    } catch {
      return all('error', 'The test runner produced no report.', tail(run.stderr || run.stdout));
    }
    const byFile = new Map<string, ReportTest[]>();
    for (const suite of report.suites ?? []) {
      const key = path.basename(suite.file ?? '');
      byFile.set(key, [...(byFile.get(key) ?? []), ...collectTests([suite])]);
    }
    const global = (report.errors ?? []).map((e) => clean(e.message ?? '')).join('\n');
    return files.map((f, i) => interpret(i, byFile.get(path.basename(f)) ?? [], global || tail(run.stderr)));
  } finally {
    await rm(wrapper, { force: true });
    await rm(tmp, { recursive: true, force: true });
    releaseWrapper();
    releaseTmp();
  }

  function interpret(i: number, tests: ReportTest[], globalError: string): VerifyResult {
    const file = files[i]!;
    const source = sources[i]!;
    const recordedErrors = recordedFor(i);
    if (!tests.length) return makeResult(i, 'error', 'No test was run.', globalError);
    const results = tests.flatMap((t) => t.results ?? []);
    const failed = results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
    if (!failed) {
      return makeResult(
        i,
        'passed',
        recordedErrors.length
          ? 'The test passed: the recorded error did not happen. If the bug is not fixed yet, it was not reproduced (see the notes on network data and app state).'
          : 'The test passed.',
      );
    }
    const errors = failed.errors?.length ? failed.errors : failed.error ? [failed.error] : [];
    const message = clean(errors.map((e) => e.message ?? '').join('\n\n')) || `Test ${failed.status}.`;
    const line = errors.find((e) => e.location?.file && samePath(e.location.file, file))?.location?.line;
    const step = line ? stepAt(source, line) : undefined;

    // Compare with the errors the page actually produced. Never with the raw failure message:
    // it contains a code frame, and the generated comments quote the recorded error.
    const observed = observedErrors(tests, failed) ?? [stripCodeFrame(message)];
    // An empty recorded message (console.error() with no arguments) would match anything.
    const matched = matchRecordedError(recordedErrors, observed);
    if (matched) {
      return makeResult(
        i,
        'reproduced',
        `Reproduced: the test fails with the error recorded in the session ("${truncate(matched, 120)}").`,
        message,
        step,
        matched,
      );
    }
    if (!recordedErrors.length) {
      return makeResult(
        i,
        'failed',
        `The test failed${step ? ` at ${step.id} (${step.description})` : ''}. The recording had no error to compare with.`,
        message,
        step,
      );
    }
    const hint = /Timeout|waiting for|resolved to \d+ elements|strict mode violation/i.test(message)
      ? ' A locator did not match: the UI may differ from the recording, or an earlier step did not have its effect.'
      : '';
    return makeResult(
      i,
      'failed-differently',
      `The test failed${step ? ` at ${step.id} (${step.description})` : ''}, but not with the recorded error.${hint}`,
      message,
      step,
    );
  }

  function recordedFor(i: number): string[] {
    return opts.expectedErrors ?? parseMeta(sources[i]!)?.errors ?? [];
  }

  function makeResult(
    i: number,
    verdict: Verdict,
    summary: string,
    error?: string,
    failedStep?: VerifyResult['failedStep'],
    matchedError?: string,
  ): VerifyResult {
    return {
      verdict,
      summary,
      durationMs: Date.now() - started,
      failedStep,
      error: error ? tail(error, 4000) : undefined,
      recordedErrors: recordedFor(i),
      matchedError,
      command,
      ...(opts.expect ? { ok: verdict === opts.expect } : {}),
    };
  }
}

function observedErrors(tests: ReportTest[], result: ReportResult): string[] | null {
  const annotations = [...(result.annotations ?? []), ...tests.flatMap((t) => t.annotations ?? [])];
  const a = annotations.find((x) => x.type === ERRORS_ANNOTATION);
  if (!a?.description) return null;
  try {
    const list = JSON.parse(a.description);
    return Array.isArray(list) ? list.map(String) : null;
  } catch {
    return null;
  }
}

/** Removes `  12 | code` / `> 13 | code` / `     |   ^` lines from a failure message. */
export function stripCodeFrame(message: string): string {
  return message
    .split('\n')
    .filter((l) => !/^\s*>?\s*\d*\s*\|/.test(l))
    .join('\n');
}

export function parseMeta(source: string): TestMeta | null {
  const line = source.split('\n').find((l) => l.startsWith(META_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(META_PREFIX.length));
  } catch {
    return null;
  }
}

/** The step whose code contains `line`, found via the `// sN · ...` comments the generator writes. */
export function stepAt(source: string, line: number): VerifyResult['failedStep'] {
  const lines = source.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^\s*\/\/ (s\d+) · (.*)$/.exec(lines[i]!);
    if (m) return { id: m[1]!, description: m[2]!, line };
    if (/^\s*\/\/ Recorded in the session:|^test\(/.test(lines[i]!)) break;
  }
  return undefined;
}

/** "Uncaught TypeError: x is undefined" → "x is undefined" (how page errors are reported on replay). */
/** The recorded error the observed errors contain, if any. Empty or trivial messages never match. */
export function matchRecordedError(recorded: string[], observed: string[]): string | undefined {
  return recorded.find((rec) => {
    const c = core(rec);
    return c.length >= 3 && observed.some((o) => o.includes(c));
  });
}

function core(message: string): string {
  return message
    .replace(/^Uncaught\s+(\(in promise\)\s+)?/, '')
    .replace(/^[A-Z]\w*(Error|Exception):\s*/, '')
    .trim();
}

function wrapperConfig(
  userConfig: string | undefined,
  testDir: string,
  testFiles: string[],
  allProjects: boolean,
  workers: number,
): string {
  const head = userConfig
    ? `import base from ${JSON.stringify(`./${path.basename(userConfig).replace(/\.ts$/, '')}`)};\nconst b = base.default ?? base;\n`
    : 'const b = {};\n';
  return `${head}// Temporary config written by bugprint verify; deleted after the run.
const ours = { testDir: ${JSON.stringify(testDir)}, testMatch: ${JSON.stringify(testFiles)}, testIgnore: [] };
const run = { retries: 0, workers: ${workers}, fullyParallel: true, reporter: [['json']] };
let config;
if (Array.isArray(b.projects) && b.projects.length) {
  const all = b.projects;
  // Projects others depend on (auth "setup", teardown) keep their own files and settings.
  const depended = new Set(all.flatMap((p) => [...(p.dependencies ?? []), ...(p.teardown ? [p.teardown] : [])]));
  const leaves = all.filter((p) => !depended.has(p.name));
  const pool = leaves.length ? leaves : all;
  const chosen = ${allProjects} ? pool : pool.slice(0, 1);
  const needed = new Set();
  const visit = (name) => {
    if (needed.has(name)) return;
    needed.add(name);
    const p = all.find((x) => x.name === name);
    for (const d of p?.dependencies ?? []) visit(d);
    if (p?.teardown) visit(p.teardown);
  };
  for (const p of chosen) {
    for (const d of p.dependencies ?? []) visit(d);
    if (p.teardown) visit(p.teardown);
  }
  const projects = all
    .filter((p) => chosen.includes(p) || needed.has(p.name))
    .map((p) => (chosen.includes(p) ? { ...p, ...ours } : p));
  // The root testDir stays the user's, so dependency projects without their own still find their files.
  config = { ...b, ...run, projects };
} else {
  config = { ...b, ...ours, ...run };
}
export default config;
`;
}

function exec(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const release = trackChild(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-200_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-200_000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, o.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      release();
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      release();
      resolve({ code: null, stdout, stderr: String(err), timedOut });
    });
  });
}

// ---- report shape (subset of the JSON reporter output) -------------------------
interface ReportError {
  message?: string;
  location?: { file: string; line: number; column: number };
}
interface ReportAnnotation {
  type: string;
  description?: string;
}
interface ReportTest {
  results?: ReportResult[];
  annotations?: ReportAnnotation[];
}
interface ReportResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  annotations?: ReportAnnotation[];
  errors?: ReportError[];
  error?: ReportError;
}
interface ReportSuite {
  file?: string;
  suites?: ReportSuite[];
  specs?: { tests?: ReportTest[] }[];
}
interface Report {
  suites?: ReportSuite[];
  errors?: ReportError[];
}

function collectTests(suites: ReportSuite[]): ReportTest[] {
  return suites.flatMap((s) => [...(s.specs ?? []).flatMap((sp) => sp.tests ?? []), ...collectTests(s.suites ?? [])]);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function clean(s: string): string {
  return s.replace(ANSI, '').trim();
}
function tail(s: string, n = 2000): string {
  const c = clean(s);
  return c.length > n ? `…${c.slice(-n)}` : c;
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
