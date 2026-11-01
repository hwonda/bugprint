import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERRORS_ANNOTATION, META_PREFIX, type TestMeta } from '../codegen/test.js';

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
}

const CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];

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

  const bin = findRunner(cwd);
  let command = '';
  const all = (verdict: Verdict, summary: string, error?: string) =>
    files.map((_, i) => makeResult(i, verdict, summary, error));
  if (!bin) {
    return all('error', 'The test runner is not installed in this project. Run: npm i -D @playwright/test && npx playwright install chromium');
  }

  const userConfig = CONFIG_NAMES.map((n) => path.join(cwd, n)).find((p) => existsSync(p));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'bugprint-run-'));
  const reportFile = path.join(tmp, 'report.json');
  // The wrapper must sit next to the user's config: relative paths in it (webServer.cwd,
  // globalSetup, outputDir...) are resolved against the config file's directory.
  const ext = userConfig ? path.extname(userConfig) : '.mjs';
  const wrapper = path.join(userConfig ? path.dirname(userConfig) : tmp, `.bugprint-run-${process.pid}-${Date.now()}.config${ext}`);
  const workers = opts.workers ?? (files.length > 1 ? 4 : 1);
  await writeFile(wrapper, wrapperConfig(userConfig, dir, files.map((f) => path.basename(f)), opts.allProjects ?? false, workers), 'utf8');

  const args = ['test', '--config', wrapper, '--reporter', 'json'];
  command = `${path.relative(cwd, bin) || bin} ${args.join(' ')}`;
  try {
    const run = await exec(bin, args, {
      cwd,
      timeoutMs,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
        FORCE_COLOR: '0',
        ...(opts.baseUrl ? { BUGPRINT_BASE_URL: opts.baseUrl } : {}),
      },
    });
    if (run.timedOut) return all('error', `The run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`);
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
    const line = errors.find((e) => e.location?.file && path.resolve(e.location.file) === file)?.location?.line;
    const step = line ? stepAt(source, line) : undefined;

    // Compare with the errors the page actually produced. Never with the raw failure message:
    // it contains a code frame, and the generated comments quote the recorded error.
    const observed = observedErrors(tests, failed) ?? [stripCodeFrame(message)];
    const matched = recordedErrors.find((rec) => observed.some((o) => o.includes(core(rec))));
    if (matched) {
      return makeResult(i, 'reproduced', `Reproduced: the test fails with the error recorded in the session ("${truncate(matched, 120)}").`, message, step, matched);
    }
    if (!recordedErrors.length) {
      return makeResult(i, 'failed', `The test failed${step ? ` at ${step.id} (${step.description})` : ''}. The recording had no error to compare with.`, message, step);
    }
    const hint = /Timeout|waiting for|resolved to \d+ elements|strict mode violation/i.test(message)
      ? ' A locator did not match: the UI may differ from the recording, or an earlier step did not have its effect.'
      : '';
    return makeResult(i, 'failed-differently', `The test failed${step ? ` at ${step.id} (${step.description})` : ''}, but not with the recorded error.${hint}`, message, step);
  }

  function recordedFor(i: number): string[] {
    return opts.expectedErrors ?? parseMeta(sources[i]!)?.errors ?? [];
  }

  function makeResult(i: number, verdict: Verdict, summary: string, error?: string, failedStep?: VerifyResult['failedStep'], matchedError?: string): VerifyResult {
    return { verdict, summary, durationMs: Date.now() - started, failedStep, error: error ? tail(error, 4000) : undefined, recordedErrors: recordedFor(i), matchedError, command };
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
function core(message: string): string {
  return message.replace(/^Uncaught\s+(\(in promise\)\s+)?/, '').replace(/^[A-Z]\w*(Error|Exception):\s*/, '').trim();
}

function wrapperConfig(userConfig: string | undefined, testDir: string, testFiles: string[], allProjects: boolean, workers: number): string {
  const head = userConfig
    ? `import base from ${JSON.stringify(`./${path.basename(userConfig).replace(/\.(ts|mts)$/, '')}`)};\nconst b = base.default ?? base;\n`
    : 'const b = {};\n';
  return `${head}// Temporary config written by bugprint verify; deleted after the run.
const projects = Array.isArray(b.projects) && b.projects.length
  ? (${allProjects} ? b.projects : b.projects.slice(0, 1)).map((p) => ({ ...p, testDir: undefined, testMatch: undefined, testIgnore: undefined }))
  : undefined;
export default { ...b, testDir: ${JSON.stringify(testDir)}, testMatch: ${JSON.stringify(testFiles)}, testIgnore: [], retries: 0, workers: ${workers}, fullyParallel: true, reporter: [['json']], projects };
`;
}

function findRunner(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    const bin = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    if (existsSync(bin)) return bin;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function exec(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
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
