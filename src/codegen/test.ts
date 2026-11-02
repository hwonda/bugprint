import type { Flow, NetworkCall, Signal, Step } from '../flow/extract.js';
import { describeStep, pathOf } from '../flow/summarize.js';
import { str } from '../selector/locator.js';
import { redactBody, redactValue } from './redact.js';
import { isSensitiveKey, redactSecrets, redactSecretText } from './secrets.js';

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
  /**
   * Keep tokens, API keys and values under keys like `accessToken` in recorded responses and
   * storage. Default false: they are replaced, because generated tests usually get committed.
   */
  keepSecrets?: boolean;
  /**
   * Path to a test-runner storage state file (cookies + localStorage, e.g. a logged-in user).
   * Overridable at run time with BUGPRINT_STORAGE_STATE. Recorded localStorage is layered on top.
   */
  storageState?: string;
  /** Serve recorded API responses instead of hitting the live backend. Default: true when the recording has them. */
  mockNetwork?: boolean;
  /** Start the browser clock at the time the session was recorded. Default: true. */
  freezeTime?: boolean;
  /**
   * Start the test at this navigation step (goto / expectUrl / back / forward / reload),
   * opening its URL directly and skipping everything before it.
   */
  startFrom?: string;
  /** Restore localStorage and cookies captured at the start of the recording. Default: true when captured. */
  restoreStorage?: boolean;
  /**
   * File name (next to the test) for recorded responses. When set and the responses are larger
   * than `inlineLimit` bytes, they are written there instead of inline. See GeneratedTest.files.
   */
  fixturesFile?: string;
  inlineLimit?: number;
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
  /** Extra files to write next to the test (e.g. external response fixtures). */
  files: { name: string; content: string }[];
  /** Ids of the steps the test contains, in order. */
  stepIds: string[];
}

/** Machine-readable header so `verify` can compare a run with the recording. */
export interface TestMeta {
  v: 1;
  session: string;
  errors: string[];
}
export const META_PREFIX = '// @bugprint ';
/** Annotation through which a generated test reports the page errors it actually saw. */
export const ERRORS_ANNOTATION = 'bugprint:errors';

const MAX_INLINE_BODY = 256 * 1024;
const MAX_FILE_BODY = 5 * 1024 * 1024;
const NAV_KINDS = new Set<Step['kind']>(['goto', 'expectUrl', 'reload', 'back', 'forward']);

/** Applies startFrom / includeSteps / excludeSteps and guarantees the test starts by opening a page. */
export function selectSteps(flow: Flow, opts: Pick<GenerateOptions, 'startFrom' | 'includeSteps' | 'excludeSteps'>): Step[] {
  let all = flow.steps;
  let start: Step | null = null;
  if (opts.startFrom) {
    const idx = all.findIndex((s) => s.id === opts.startFrom);
    if (idx === -1) throw new Error(`Unknown step "${opts.startFrom}".`);
    const s0 = all[idx]!;
    if (!NAV_KINDS.has(s0.kind))
      throw new Error(`startFrom must be a navigation step (goto/expectUrl/reload/back/forward); ${s0.id} is a ${s0.kind}.`);
    start = { id: s0.id, t: s0.t, url: s0.url, kind: 'goto' };
    all = all.slice(idx + 1);
  }
  const include = opts.includeSteps ? new Set(opts.includeSteps) : null;
  const exclude = new Set(opts.excludeSteps ?? []);
  let steps = all.filter((s) => (!include || include.has(s.id)) && !exclude.has(s.id));
  if (start) steps = [start, ...steps];
  const first = steps[0];
  if (first && first.kind !== 'goto') {
    steps = NAV_KINDS.has(first.kind)
      ? [{ id: first.id, t: first.t, url: first.url, kind: 'goto' }, ...steps.slice(1)]
      : [{ id: 'start', t: first.t, url: first.url, kind: 'goto' }, ...steps];
  }
  return steps;
}

export function generateTest(flow: Flow, opts: GenerateOptions = {}): GeneratedTest {
  const steps = selectSteps(flow, opts);
  if (!steps.length) throw new Error('No steps left to generate a test from.');
  const files: GeneratedTest['files'] = [];

  const notes: string[] = [];
  const errors = flow.signals.filter((s) => s.kind === 'uncaught-error' || s.kind === 'console-error' || s.kind === 'custom');
  const assertNoErrors = opts.assertNoErrors ?? errors.length > 0;
  const redact = opts.redactPii ?? true;
  const freezeTime = opts.freezeTime ?? true;
  let secretsRedacted = 0;
  const scrub = (v: string, ct: string | null) => {
    if (opts.keepSecrets) return v;
    const r = redactSecrets(v, ct);
    secretsRedacted += r.count;
    return r.value;
  };

  const recordedOrigin = originOf(flow.startUrl);
  const baseUrl = (opts.baseUrl ?? recordedOrigin ?? '').replace(/\/$/, '');
  const testName =
    opts.testName ??
    (errors[0]
      ? `repro: ${truncate(errors[0].message.replace(/^Uncaught\s+(\(in promise\)\s+)?/, ''), 90)}`
      : `repro: session ${flow.sessionId}`);
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
      if (c.responseBody.length > (opts.fixturesFile ? MAX_FILE_BODY : MAX_INLINE_BODY)) {
        tooBig++;
        continue;
      }
      responses.push({
        method: c.method,
        url: networkKey(c),
        status: c.status || 200,
        contentType: c.contentType,
        body: ((b) => (redact ? redactBody(b, c.contentType) : b))(scrub(c.responseBody, c.contentType)),
      });
    }
    if (noBody)
      notes.push(
        `${noBody} recorded API call(s) have no response body (enable recordBody in the network plugin); they go to the live backend.`,
      );
    if (tooBig) notes.push(`${tooBig} response(s) were too large to include; they go to the live backend.`);
  }
  const responsesJson = JSON.stringify(responses);
  const external = Boolean(opts.fixturesFile) && responses.length > 0 && responsesJson.length > (opts.inlineLimit ?? 64 * 1024);
  if (external) files.push({ name: opts.fixturesFile!, content: `${JSON.stringify(responses, null, 1)}\n` });
  else if (responsesJson.length > (opts.inlineLimit ?? 64 * 1024))
    notes.push('Recorded responses are large; pass an outputPath so they can be stored in a separate fixtures file.');

  // ---- storage ---------------------------------------------------------------
  const storage = flow.initialStorage;
  const restore =
    (opts.restoreStorage ?? true) && storage && (Object.keys(storage.localStorage).length || Object.keys(storage.cookies).length);
  if (opts.storageState && storage && Object.keys(storage.cookies).length) {
    notes.push('Recorded cookies are not applied because a storageState file was given; it provides the cookies.');
  }
  if (storage?.masked.length) {
    notes.push(
      `The recorder left out sensitive storage entries (${storage.masked.join(', ')}). If the bug needs a logged-in user, provide storageState yourself.`,
    );
  }
  if (restore && storage && originOf(storage.origin) !== recordedOrigin) {
    notes.push(`Initial storage was captured on ${storage.origin}, not on the start page origin; it was not restored.`);
  }
  const storageLines: string[] = [];
  const restorable = Boolean(restore && storage && originOf(storage.origin) === recordedOrigin);
  const val = (k: string, v: string) => {
    if (!opts.keepSecrets && isSensitiveKey(k)) {
      secretsRedacted++;
      return null; // drop entirely: a fake token is worse than none
    }
    const cleaned = scrub(v, null);
    return redact ? redactBody(cleaned, 'application/json') : cleaned;
  };
  const lsEntries = restorable
    ? Object.entries(storage!.localStorage).flatMap(([k, v]) => ((x) => (x === null ? [] : [[k, x] as const]))(val(k, v)))
    : [];
  const cookieEntries = restorable
    ? Object.entries(storage!.cookies).flatMap(([k, v]) => ((x) => (x === null ? [] : [[k, x] as const]))(val(k, v)))
    : [];
  if (opts.storageState) {
    storageLines.push(
      '// Storage state supplied by you (e.g. a logged-in user); BUGPRINT_STORAGE_STATE overrides it.',
      `test.use({ storageState: process.env.BUGPRINT_STORAGE_STATE ?? ${str(opts.storageState)} });`,
      '',
    );
  } else if (lsEntries.length || cookieEntries.length) {
    const ls = lsEntries.map(([name, value]) => `{ name: ${str(name)}, value: ${str(value)} }`);
    const cookies = cookieEntries.map(
      ([name, value]) =>
        `{ name: ${str(name)}, value: ${str(value)}, domain: new URL(BASE_URL).hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }`,
    );
    storageLines.push(
      '// Browser storage when the recording started. Sensitive keys were never recorded.',
      'test.use({',
      '  storageState: {',
      `    cookies: [${cookies.length ? `\n      ${cookies.join(',\n      ')},\n    ` : ''}],`,
      `    origins: [{ origin: new URL(BASE_URL).origin, localStorage: [${ls.length ? `\n      ${ls.join(',\n      ')},\n    ` : ''}] }],`,
      '  },',
      '});',
      '',
    );
  }
  // With a user-supplied storage state, layer the recorded localStorage on top, once per tab.
  const seedLines: string[] = [];
  if (opts.storageState && lsEntries.length) {
    seedLines.push(
      '  await page.addInitScript(([origin, items]) => {',
      "    if (location.origin !== origin || sessionStorage.getItem('__bugprint_seeded')) return;",
      '    for (const [k, v] of items) localStorage.setItem(k, v);',
      "    sessionStorage.setItem('__bugprint_seeded', '1');",
      `  }, [new URL(BASE_URL).origin, ${JSON.stringify(lsEntries)}] as const);`,
    );
  }

  if (!flow.capabilities.network) {
    notes.push(
      'The recording has no network data, so the test runs against your live backend. Bugs that depend on API data may not reproduce. Record with the rrweb network plugin (recordBody: true) to capture responses.',
    );
  }
  if (!flow.capabilities.console) {
    notes.push('The recording has no console data, so errors could not be captured. Add the rrweb console plugin to the recorder.');
  }

  // ---- body --------------------------------------------------------------------
  const secrets: string[] = [];
  const body: string[] = [];
  body.push(...seedLines);
  if (freezeTime)
    body.push(
      `  await page.clock.install({ time: new Date(${str(new Date(flow.recordedAt).toISOString())}) }); // when the session was recorded`,
    );
  if (external) {
    body.push(
      `  const RECORDED_RESPONSES: RecordedResponse[] = JSON.parse(readFileSync(path.join(path.dirname(test.info().file), ${str(opts.fixturesFile!)}), 'utf8'));`,
    );
  }
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
  // After the error check: if the page crashed, the expected text never shows up, and a
  // timeout there would hide the real failure (found by running an agent against bugprint).
  if (opts.expectVisibleText) {
    tail.push(`  await expect(page.getByText(${str(opts.expectVisibleText)})).toBeVisible();`);
  }
  if (!tail.length) {
    tail.push('  // TODO: no error was recorded. Assert the expected behaviour here, e.g.:');
    tail.push("  // await expect(page.getByRole('alert')).toHaveText('Order placed');");
  }

  if (secretsRedacted)
    notes.push(
      `${secretsRedacted} secret value(s) (tokens, API keys, sensitive storage keys) were replaced or left out. Pass keepSecrets to keep them.`,
    );

  // ---- assemble ------------------------------------------------------------------
  const meta: TestMeta = { v: 1, session: flow.sessionId, errors: relevant.map((e) => e.message) };
  const out: string[] = [
    '// Generated by bugprint from a recorded user session.',
    `// Pages: ${flow.pages.map(pathOf).join(' → ')}`,
    '// The test is expected to FAIL while the bug exists and pass once it is fixed.',
    `${META_PREFIX}${JSON.stringify(meta)}`,
    ...(external ? ["import { readFileSync } from 'node:fs';", "import path from 'node:path';"] : []),
    `import { test, expect${responses.length ? ', type Page' : ''} } from '@playwright/test';`,
    '',
    `const BASE_URL = process.env.BUGPRINT_BASE_URL ?? ${str(baseUrl)};`,
    '',
    ...storageLines,
  ];
  if (responses.length && !external) {
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
      '  // Reported to `bugprint verify` even when a later step fails first (the annotation is live).',
      `  const observed = { type: ${str(ERRORS_ANNOTATION)}, description: '[]' };`,
      '  test.info().annotations.push(observed);',
      '  const record = (message: string) => {',
      '    errors.push(message);',
      '    observed.description = JSON.stringify(errors);',
      '  };',
      "  page.on('pageerror', (err) => record(err.message));",
      "  page.on('console', (msg) => {",
      '    // The browser logs every failed request as an error; network failures are not page errors.',
      "    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) record(msg.text());",
      '  });',
      '',
    );
  }
  out.push(...body, '', ...tail, '});', '');
  if (responses.length) out.push(...SERVE_HELPER);

  return {
    code: out.join('\n'),
    testName,
    stepCount: steps.length,
    stepIds: steps.map((s) => s.id),
    secrets,
    recordedErrors: relevant,
    mockedResponses: responses.length,
    notes,
    files,
  };

  function networkKey(c: NetworkCall): string {
    // Requests never carry the #fragment, so the key must not either.
    const u = c.url.replace(/#.*$/, '');
    return originOf(u) === recordedOrigin ? pathOf(u) : u;
  }

  /**
   * Controls inside a list row are often only shown while the row is hovered (delete buttons,
   * row menus). The user hovered the row before clicking; do the same so the control is visible.
   */
  function hover(t: { hoverCode?: string }): string[] {
    return t.hoverCode ? [`  await ${t.hoverCode}.hover();`] : [];
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
        return [...hover(s.target), `  await ${s.target.code}.click();`];
      case 'dblclick':
        return [...hover(s.target), `  await ${s.target.code}.dblclick();`];
      case 'rightclick':
        return [...hover(s.target), `  await ${s.target.code}.click({ button: 'right' });`];
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
        const value = ((v) => (opts.keepSecrets ? v : redactSecretText(v)))(redact ? redactValue(s.value) : s.value);
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
  '  const keyOf = (method: string, u: URL) => `${method} ${u.origin === base ? u.pathname + u.search : u.origin + u.pathname + u.search}`;',
  "  await page.route('**/*', (route) => {",
  '    const req = route.request();',
  '    const u = new URL(req.url());',
  '    // Cross-origin APIs need CORS headers on the mocked response, and their preflight answered.',
  "    const origin = req.headers()['origin'];",
  "    const cors: Record<string, string> = u.origin !== base && origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {};",
  "    if (req.method() === 'OPTIONS' && [...queues.keys()].some((k) => k.slice(k.indexOf(' ') + 1) === keyOf('', u).trim())) {",
  "      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': '*', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*' } });",
  '    }',
  '    const queue = queues.get(keyOf(req.method(), u));',
  '    if (!queue?.length) return route.fallback();',
  '    const r = queue.length > 1 ? queue.shift()! : queue[0]!;',
  '    return route.fulfill({ status: r.status, contentType: r.contentType ?? undefined, headers: cors, body: r.body });',
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
