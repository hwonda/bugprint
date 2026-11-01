import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { redactValue } from './codegen/redact.js';
import { generateTest } from './codegen/test.js';
import type { Flow, Step } from './flow/extract.js';
import { describeStep, fmtTime, pathOf, summarizeFlow } from './flow/summarize.js';
import { SessionStore } from './store.js';
import { verifyTest } from './verify/run.js';
import { VERSION } from './version.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

const windowShape = {
  fromMs: z.number().int().nonnegative().optional().describe('Start of the window, ms since recording start (see timestamps in summarize_session).'),
  toMs: z.number().int().nonnegative().optional().describe('End of the window, ms since recording start.'),
};

function compactStep(s: Step) {
  const base = { id: s.id, t: s.t, at: fmtTime(s.t), kind: s.kind, does: describeStep(s) };
  if ('target' in s && s.target) {
    return {
      ...base,
      locator: s.target.code,
      confidence: s.target.locator.confidence,
      ...('value' in s ? { value: 'masked' in s && s.masked ? '<masked>' : redactValue(s.value) } : {}),
    };
  }
  return { ...base, url: pathOf(s.url) };
}

function overview(flow: Flow) {
  const errors = flow.signals.filter((s) => s.kind !== 'console-warn');
  return {
    sessionId: flow.sessionId,
    duration: fmtTime(flow.durationMs),
    pages: flow.pages.map(pathOf),
    steps: flow.steps.length,
    apiCalls: flow.network.length,
    recorded: flow.capabilities,
    errors: errors.map((e) => ({ at: fmtTime(e.t), afterStep: e.afterStepId, kind: e.kind, message: e.message, source: e.trace[0] })),
  };
}

export function createServer(store = new SessionStore()): McpServer {
  const server = new McpServer(
    { name: 'bugprint', version: VERSION },
    {
      instructions:
        'bugprint turns a recorded user session (rrweb events) into a failing end-to-end test that reproduces the bug. ' +
        'Typical flow: load_session → summarize_session (cheap overview) → generate_test with outputPath → run_and_verify (expect verdict "reproduced") → fix the code → run_and_verify again (expect "passed"). ' +
        'If run_and_verify says "failed-differently", read failedStep and adjust (trim steps with includeSteps/excludeSteps, or set baseUrl) before touching app code. ' +
        'Use extract_flow only when you need structured step data.',
    },
  );

  server.registerTool(
    'load_session',
    {
      title: 'Load a recorded session',
      description:
        'Load an rrweb recording (array of events, {events:[...]}, or NDJSON) from a file path or inline JSON. Returns a sessionId plus an overview: pages, step count and captured errors.',
      inputSchema: {
        path: z.string().optional().describe('Path to the recording file (relative to the server working directory or absolute).'),
        json: z.string().optional().describe('The recording itself as a JSON string, when no file is available.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p, json: raw }) => {
      if (!p && !raw) throw new Error('Provide either "path" or "json".');
      const session = p ? await store.loadFromPath(p) : store.loadFromData(raw);
      const flow = store.flow(session.id);
      return json({ ...overview(flow), eventCount: session.events.length, warnings: flow.warnings, next: 'summarize_session or generate_test' });
    },
  );

  server.registerTool(
    'summarize_session',
    {
      title: 'Summarize a session',
      description:
        'Human-readable timeline of what the user did (one line per step, with step ids and timestamps) and where errors happened. Much cheaper than reading raw events.',
      inputSchema: { sessionId: z.string(), ...windowShape },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sessionId, fromMs, toMs }) => text(summarizeFlow(store.flow(sessionId, { fromMs, toMs }))),
  );

  server.registerTool(
    'extract_flow',
    {
      title: 'Extract structured steps',
      description:
        'Normalised user steps (goto, click, fill, check, select, navigation…) with the locator chosen for each element and its confidence, plus captured errors and warnings.',
      inputSchema: { sessionId: z.string(), ...windowShape },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sessionId, fromMs, toMs }) => {
      const flow = store.flow(sessionId, { fromMs, toMs });
      return json({
        ...overview(flow),
        steps: flow.steps.map(compactStep),
        signals: flow.signals.map((s) => ({ ...s, at: fmtTime(s.t), url: pathOf(s.url) })),
        network: flow.network.map((c) => ({ at: fmtTime(c.t), method: c.method, url: pathOf(c.url), status: c.status, hasBody: c.responseBody !== null })),
        warnings: flow.warnings,
      });
    },
  );

  server.registerTool(
    'generate_test',
    {
      title: 'Generate a reproduction test',
      description:
        'Generate an end-to-end test (@playwright/test syntax) that replays the recorded steps and fails the same way the session did. ' +
        'Pass outputPath to write it to disk. Use includeSteps/excludeSteps (ids from summarize_session) to trim irrelevant steps.',
      inputSchema: {
        sessionId: z.string(),
        ...windowShape,
        includeSteps: z.array(z.string()).optional().describe('Keep only these step ids, e.g. ["s1","s4","s7"].'),
        excludeSteps: z.array(z.string()).optional().describe('Drop these step ids.'),
        baseUrl: z.string().url().optional().describe('Run against this origin instead of the recorded one, e.g. http://localhost:3000.'),
        testName: z.string().optional(),
        expectVisibleText: z.string().optional().describe('Also assert this text becomes visible (the expected outcome when the bug is fixed).'),
        assertNoErrors: z.boolean().optional().describe('Fail on page errors / console.error. Defaults to true when the session captured an error.'),
        redactPii: z.boolean().optional().describe('Replace e-mails, phone and card numbers with fakes. Default true.'),
        mockNetwork: z.boolean().optional().describe('Serve the recorded API responses instead of the live backend. Default true when the recording has them.'),
        freezeTime: z.boolean().optional().describe('Start the browser clock at the recording time. Default true.'),
        outputPath: z.string().optional().describe('Write the test here (e.g. tests/repro/checkout.spec.ts).'),
        overwrite: z.boolean().optional().describe('Allow replacing an existing file at outputPath.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const flow = store.flow(args.sessionId, { fromMs: args.fromMs, toMs: args.toMs });
      const result = generateTest(flow, args);
      let written: string | undefined;
      if (args.outputPath) {
        const abs = path.resolve(process.cwd(), args.outputPath);
        if (!args.overwrite && (await exists(abs))) throw new Error(`${abs} already exists. Pass overwrite: true to replace it.`);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, result.code, 'utf8');
        written = abs;
      }
      const notes: string[] = [];
      if (written) notes.push(`Written to ${written}. Run it with: npx playwright test ${path.relative(process.cwd(), written)}`);
      if (result.secrets.length) notes.push(`Set ${result.secrets.join(', ')} (values were masked in the recording).`);
      if (result.mockedResponses) notes.push(`${result.mockedResponses} recorded API response(s) are served by the test.`);
      if (!result.recordedErrors.length) notes.push('No error was recorded in the selected steps: add an assertion describing the bug (or pass expectVisibleText).');
      notes.push(...result.notes, ...flow.warnings.filter((w) => !w.startsWith('No error')));
      if (written) notes.push('Next: run_and_verify with this testPath.');
      return text(`${notes.map((n) => `// ${n}`).join('\n')}\n\n${result.code}`);
    },
  );

  server.registerTool(
    'run_and_verify',
    {
      title: 'Run a reproduction test and check it',
      description:
        "Run a generated test with the project's own test runner config and compare the outcome with the recording. " +
        'Verdicts: "reproduced" (fails with the recorded error — ready to fix), "failed-differently" (fails elsewhere; see failedStep), ' +
        '"passed" (bug fixed, or not reproduced if you have not fixed anything yet), "failed" (no recorded error to compare), "error" (runner problem).',
      inputSchema: {
        testPath: z.string().describe('Path to the generated test file.'),
        baseUrl: z.string().url().optional().describe('Origin to run against (exported as BUGPRINT_BASE_URL).'),
        cwd: z.string().optional().describe('Project root containing the test runner config. Defaults to the server working directory.'),
        timeoutMs: z.number().int().positive().optional().describe('Kill the run after this long. Default 180000.'),
        allProjects: z.boolean().optional().describe('Run every configured browser project instead of the first one.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ testPath, baseUrl, cwd, timeoutMs, allProjects }) => json(await verifyTest(testPath, { baseUrl, cwd, timeoutMs, allProjects })),
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List loaded sessions',
      description: 'Sessions loaded in this server process.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json(store.list().map((s) => ({ sessionId: s.id, source: s.source, events: s.events.length, duration: fmtTime(s.durationMs) }))),
  );

  server.registerPrompt(
    'reproduce_bug',
    {
      title: 'Reproduce a bug from a recording',
      description: 'Turn a session recording into a failing test, then fix the bug until the test passes.',
      argsSchema: {
        recording: z.string().describe('Path to the rrweb recording'),
        baseUrl: z.string().optional().describe('Where the app runs locally'),
      },
    },
    ({ recording, baseUrl }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Reproduce the bug captured in ${recording}.`,
              '1. load_session with that path, then summarize_session.',
              '2. Identify the error and the steps that lead to it; drop steps that are clearly unrelated.',
              `3. generate_test${baseUrl ? ` with baseUrl ${baseUrl}` : ''} and write it under tests/repro/.`,
              '4. run_and_verify the test. Continue only when the verdict is "reproduced"; if it is "failed-differently" or "passed", adjust the test first.',
              '5. Find the root cause in the source and fix it. run_and_verify again until the verdict is "passed". Keep the test as a regression test.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
