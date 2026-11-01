import type { Flow, NetworkCall, Signal, Step } from '../flow/extract.js';
import { describeStep, pathOf } from '../flow/summarize.js';
import { str } from '../selector/locator.js';
import { redactBody, redactValue } from './redact.js';

export interface GenerateOptions {
  /** Test title. Defaults to the first recorded error. */
  testName?: string;
  /** Origin to run against instead of the recorded one (e.g. http://localhost:3000). */
  baseUrl?: string;
  /** Keep only these step ids (manual minimisation). */
  includeSteps?: string[];
  /** Drop these step ids. */
  excludeSteps?: string[];
  /** Fail the test when the page throws or logs an error. Default: true when an error was recorded. */
  assertNoErrors?: boolean;
  /** Additionally assert that this text is visible at the end (the expected, non-buggy outcome). */
  expectVisibleText?: string;
  /** Replace e-mails, phone and card numbers with structurally similar fakes. Default: true. */
  redactPii?: boolean;
  /** Serve recorded API responses instead of hitting the live backend. Default: true when the recording has them. */
  mockNetwork?: boolean;
  /** Start the browser clock at the time the session was recorded. Default: true. */
  freezeTime?: boolean;
}

export interface GeneratedTest {
  code: string;
  testName: string;
  stepCount: number;
  secrets: string[];
  recordedErrors: Signal[];
  mockedResponses: number;
  /** Things the caller (agent or human) should know about this test. */
  notes: string[];
}

/** Machine-readable header so `verify` can compare a run with the recording. */
export interface TestMeta {
  v: 1;
  session: string;
  errors: string[];
}
export const META_PREFIX = '// @bugprint ';

const MAX_BODY = 256 * 1024;

export function generateTest(flow: Flow, opts: GenerateOptions = {}): GeneratedTest {
  const include = opts.includeSteps ? new Set(opts.includeSteps) : null;
  const exclude = new Set(opts.excludeSteps ?? []);
  const steps = flow.steps.filter((s) => (!include || include.has(s.id)) && !exclude.has(s.id));
  if (!steps.length) throw new Error('No steps left to generate a test from.');

  const notes: string[] = [];
  const errors = flow.signals.filter((s) => s.kind === 'uncaught-error' || s.kind === 'console-error' || s.kind === 'custom');
  const assertNoErrors = opts.assertNoErrors ?? errors.length > 0;
  const redact = opts.redactPii ?? true;
  const freezeTime = opts.freezeTime ?? true;

  const recordedOrigin = originOf(flow.startUrl);
  const baseUrl = (opts.baseUrl ?? recordedOrigin ?? '').replace(/\/$/, '');
  const testName = opts.testName ?? (errors[0] ? `repro: ${truncate(errors[0].message.replace(/^Uncaught\s+(\(in promise\)\s+)?/, ''), 90)}` : `repro: session ${flow.sessionId}`);
  const firstT = steps[0]!.t;

  // ---- network ---------------------------------------------------------------
  const calls = flow.network.filter((c) => c.t >= firstT);
  const mockNetwork = opts.mockNetwork ?? calls.length > 0;
  const responses: { method: string; url: string; status: number; contentType: string | null; body: string }[] = [];
  if (mockNetwork) {
    let noBody = 0;
    let tooBig = 0;
    for (const c of calls) {
      if (c.responseBody === null) {
        noBody++;
        continue;
      }
      if (c.responseBody.length > MAX_BODY) {
        tooBig++;
        continue;
      }
      responses.push({
        method: c.method,
        url: networkKey(c),
        status: c.status || 200,
        contentType: c.contentType,
        body: redact ? redactBody(c.responseBody, c.contentType) : c.responseBody,
      });
    }
    if (noBody) notes.push(`${noBody} recorded API call(s) have no response body (enable recordBody in the network plugin); they go to the live backend.`);
    if (tooBig) notes.push(`${tooBig} response(s) larger than ${MAX_BODY / 1024} KB were not inlined; they go to the live backend.`);
  }
  if (!flow.capabilities.network) {
    notes.push('The recording has no network data, so the test runs against your live backend. Bugs that depend on API data may not reproduce. Record with the rrweb network plugin (recordBody: true) to capture responses.');
  }
  if (!flow.capabilities.console) {
    notes.push('The recording has no console data, so errors could not be captured. Add the rrweb console plugin to the recorder.');
  }

  // ---- body --------------------------------------------------------------------
  const secrets: string[] = [];
  const body: string[] = [];
  if (freezeTime) body.push(`  await page.clock.install({ time: new Date(${str(new Date(flow.recordedAt).toISOString())}) }); // when the session was recorded`);
  if (responses.length) body.push('  await serveRecordedResponses(page, RECORDED_RESPONSES);');
  if (body.length) body.push('');

  for (const s of steps) {
    body.push(`  // ${s.id} · ${describeStep(s, redact).replace(/\n/g, ' ')}`);
    body.push(...renderStep(s));
  }

  // Wait roughly as long as the recorded app took to fail after the last kept step.
  const lastStep = steps.at(-1)!;
  const relevant = errors.filter((e) => e.t >= firstT);
  const lag = relevant.length ? Math.max(0, ...relevant.map((e) => e.t - lastStep.t)) : 0;
  const settle = Math.min(3000, Math.max(300, Math.round(lag + 250)));

  const tail: string[] = [];
  if (opts.expectVisibleText) {
    tail.push(`  await expect(page.getByText(${str(opts.expectVisibleText)})).toBeVisible();`);
  }
  if (assertNoErrors) {
    tail.push(`  await page.waitForTimeout(${settle});`);
    if (relevant.length) {
      tail.push('  // Recorded in the session:');
      for (const e of relevant.slice(0, 3)) {
        tail.push(`  //   ${truncate(e.message, 110)}`);
        if (e.trace[0]) tail.push(`  //     at ${truncate(e.trace[0], 100)}`);
      }
    }
    tail.push("  expect(errors, 'the page should not throw while replaying the recorded steps').toEqual([]);");
  }
  if (!tail.length) {
    tail.push('  // TODO: no error was recorded. Assert the expected behaviour here, e.g.:');
    tail.push("  // await expect(page.getByRole('alert')).toHaveText('Order placed');");
  }

  // ---- assemble ------------------------------------------------------------------
  const meta: TestMeta = { v: 1, session: flow.sessionId, errors: relevant.map((e) => e.message) };
  const out: string[] = [
    '// Generated by bugprint from a recorded user session.',
    `// Pages: ${flow.pages.map(pathOf).join(' → ')}`,
    '// The test is expected to FAIL while the bug exists and pass once it is fixed.',
    `${META_PREFIX}${JSON.stringify(meta)}`,
    `import { test, expect${responses.length ? ', type Page' : ''} } from '@playwright/test';`,
    '',
    `const BASE_URL = process.env.BUGPRINT_BASE_URL ?? ${str(baseUrl)};`,
    '',
  ];
  if (responses.length) {
    out.push(
      '// API responses captured in the recording. They are served instead of the live backend,',
      '// so the app sees exactly the data the user saw.',
      'const RECORDED_RESPONSES: RecordedResponse[] = [',
      ...responses.map((r) => `  ${JSON.stringify(r)},`),
      '];',
      '',
    );
  }
  out.push(`test(${str(testName)}, async ({ page }) => {`);
  if (assertNoErrors) {
    out.push(
      '  const errors: string[] = [];',
      "  page.on('pageerror', (err) => errors.push(err.message));",
      "  page.on('console', (msg) => {",
      "    if (msg.type() === 'error') errors.push(msg.text());",
      '  });',
      '',
    );
  }
  out.push(...body, '', ...tail, '});', '');
  if (responses.length) out.push(...SERVE_HELPER);

  return { code: out.join('\n'), testName, stepCount: steps.length, secrets, recordedErrors: relevant, mockedResponses: responses.length, notes };

  function networkKey(c: NetworkCall): string {
    return originOf(c.url) === recordedOrigin ? pathOf(c.url) : c.url;
  }

  function url(u: string): string {
    const origin = originOf(u);
    if (origin && origin === recordedOrigin) return `BASE_URL + ${str(pathOf(u))}`;
    return str(u);
  }

  function renderStep(s: Step): string[] {
    switch (s.kind) {
      case 'goto':
        return [`  await page.goto(${url(s.url)});`];
      case 'reload':
        return ['  await page.reload();'];
      case 'back':
        return ['  await page.goBack();'];
      case 'forward':
        return ['  await page.goForward();'];
      case 'expectUrl':
        return [`  await expect(page).toHaveURL(${url(s.url)});`];
      case 'click':
        return [`  await ${s.target.code}.click();`];
      case 'dblclick':
        return [`  await ${s.target.code}.dblclick();`];
      case 'rightclick':
        return [`  await ${s.target.code}.click({ button: 'right' });`];
      case 'check':
        return [`  await ${s.target.code}.check();`];
      case 'uncheck':
        return [`  await ${s.target.code}.uncheck();`];
      case 'select':
        return [`  await ${s.target.code}.selectOption(${str(s.value)});`];
      case 'press':
        return [s.target ? `  await ${s.target.code}.press(${str(s.key)});` : `  await page.keyboard.press(${str(s.key)});`];
      case 'fill': {
        if (s.masked) {
          const name = `BUGPRINT_SECRET_${secrets.length + 1}`;
          secrets.push(name);
          return [`  await ${s.target.code}.fill(process.env.${name} ?? ''); // value was masked in the recording`];
        }
        const value = redact ? redactValue(s.value) : s.value;
        const note = value !== s.value ? ' // redacted' : '';
        return [`  await ${s.target.code}.fill(${str(value)});${note}`];
      }
    }
  }
}

const SERVE_HELPER = [
  'type RecordedResponse = { method: string; url: string; status: number; contentType: string | null; body: string };',
  '',
  '/** Serves recorded responses in order (the last one repeats). Anything not recorded goes to the network. */',
  'async function serveRecordedResponses(page: Page, responses: RecordedResponse[]) {',
  '  const queues = new Map<string, RecordedResponse[]>();',
  '  for (const r of responses) {',
  '    const key = `${r.method} ${r.url}`;',
  '    queues.set(key, [...(queues.get(key) ?? []), r]);',
  '  }',
  '  const base = new URL(BASE_URL).origin;',
  "  await page.route('**/*', (route) => {",
  '    const req = route.request();',
  '    const u = new URL(req.url());',
  '    const queue = queues.get(`${req.method()} ${u.origin === base ? u.pathname + u.search : u.href}`);',
  '    if (!queue?.length) return route.fallback();',
  '    const r = queue.length > 1 ? queue.shift()! : queue[0]!;',
  '    return route.fulfill({ status: r.status, contentType: r.contentType ?? undefined, body: r.body });',
  '  });',
  '}',
  '',
];

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
