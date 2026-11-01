import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { META_PREFIX, type TestMeta } from '../codegen/test.js';

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
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const file = path.resolve(cwd, testPath);
  const source = await readFile(file, 'utf8');
  const recordedErrors = opts.expectedErrors ?? parseMeta(source)?.errors ?? [];
  const started = Date.now();

  const bin = findRunner(cwd);
  if (!bin) {
    return result('error', 'The test runner is not installed in this project. Run: npm i -D @playwright/test && npx playwright install chromium');
  }

  const userConfig = CONFIG_NAMES.map((n) => path.join(cwd, n)).find((p) => existsSync(p));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'bugprint-run-'));
  const reportFile = path.join(tmp, 'report.json');
  // The wrapper must sit next to the user's config: relative paths in it (webServer.cwd,
  // globalSetup, outputDir...) are resolved against the config file's directory.
  const ext = userConfig ? path.extname(userConfig) : '.mjs';
  const wrapper = path.join(userConfig ? path.dirname(userConfig) : tmp, `.bugprint-run-${process.pid}-${Date.now()}.config${ext}`);
  await writeFile(wrapper, wrapperConfig(userConfig, file, opts.allProjects ?? false), 'utf8');

  const args = ['test', '--config', wrapper, '--reporter', 'json'];
  const command = `${path.relative(cwd, bin) || bin} ${args.join(' ')}`;
  try {
    const run = await exec(bin, args, {
      cwd,
      timeoutMs: opts.timeoutMs ?? 180_000,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
        FORCE_COLOR: '0',
        ...(opts.baseUrl ? { BUGPRINT_BASE_URL: opts.baseUrl } : {}),
      },
    });
    if (run.timedOut) return result('error', `The run exceeded ${Math.round((opts.timeoutMs ?? 180_000) / 1000)}s and was stopped.`);
    let report: Report;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8'));
    } catch {
      return result('error', 'The test runner produced no report.', tail(run.stderr || run.stdout));
    }
    return interpret(report, run.stderr);
  } finally {
    await rm(wrapper, { force: true });
    await rm(tmp, { recursive: true, force: true });
  }

  function interpret(report: Report, stderr: string): VerifyResult {
    const tests = collectTests(report.suites ?? []);
    if (!tests.length) {
      const global = (report.errors ?? []).map((e) => clean(e.message ?? '')).join('\n');
      return result('error', 'No test was run.', global || tail(stderr));
    }
    const results = tests.flatMap((t) => t.results ?? []);
    const failed = results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
    if (!failed) {
      return result(
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

    const matched = recordedErrors.find((rec) => message.includes(core(rec)));
    if (matched) {
      return result('reproduced', `Reproduced: the test fails with the error recorded in the session ("${truncate(matched, 120)}").`, message, step, matched);
    }
    if (!recordedErrors.length) {
      return result('failed', `The test failed${step ? ` at ${step.id} (${step.description})` : ''}. The recording had no error to compare with.`, message, step);
    }
    const hint = /Timeout|waiting for|resolved to \d+ elements|strict mode violation/i.test(message)
      ? ' A locator did not match: the UI may differ from the recording, or an earlier step did not have its effect.'
      : '';
    return result('failed-differently', `The test failed${step ? ` at ${step.id} (${step.description})` : ''}, but not with the recorded error.${hint}`, message, step);
  }

  function result(verdict: Verdict, summary: string, error?: string, failedStep?: VerifyResult['failedStep'], matchedError?: string): VerifyResult {
    return { verdict, summary, durationMs: Date.now() - started, failedStep, error: error ? tail(error, 4000) : undefined, recordedErrors, matchedError, command };
  }
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

function wrapperConfig(userConfig: string | undefined, file: string, allProjects: boolean): string {
  const testDir = JSON.stringify(path.dirname(file));
  const testMatch = JSON.stringify(path.basename(file));
  const head = userConfig
    ? `import base from ${JSON.stringify(`./${path.basename(userConfig).replace(/\.(ts|mts)$/, '')}`)};\nconst b = base.default ?? base;\n`
    : 'const b = {};\n';
  return `${head}// Temporary config written by bugprint verify; deleted after the run.
const projects = Array.isArray(b.projects) && b.projects.length
  ? (${allProjects} ? b.projects : b.projects.slice(0, 1)).map((p) => ({ ...p, testDir: undefined, testMatch: undefined, testIgnore: undefined }))
  : undefined;
export default { ...b, testDir: ${testDir}, testMatch: ${testMatch}, testIgnore: [], retries: 0, workers: 1, reporter: [['json']], projects };
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
interface ReportResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  errors?: ReportError[];
  error?: ReportError;
}
interface ReportSuite {
  suites?: ReportSuite[];
  specs?: { tests?: { results?: ReportResult[] }[] }[];
}
interface Report {
  suites?: ReportSuite[];
  errors?: ReportError[];
}

function collectTests(suites: ReportSuite[]): { results?: ReportResult[] }[] {
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
