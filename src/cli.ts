#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateTest } from './codegen/test.js';
import { extractFlow } from './flow/extract.js';
import { summarizeFlow } from './flow/summarize.js';
import { createServer } from './server.js';
import { loadSessionFile } from './session/load.js';
import { VERSION } from './version.js';

const HELP = `bugprint ${VERSION} — turn recorded user sessions into failing reproduction tests

Usage:
  bugprint                          start the MCP server on stdio
  bugprint summarize <recording>    print the step timeline and captured errors
  bugprint generate <recording>     print (or write) a reproduction test

Options for generate:
  -o, --out <file>        write the test to a file
      --base-url <url>    run against this origin instead of the recorded one
      --from <ms> --to <ms>   only use steps inside this window
      --include <s1,s4>   keep only these step ids
      --exclude <s2,s3>   drop these step ids
      --expect-text <t>   assert this text is visible at the end
      --no-redact         keep typed values as recorded
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'serve' || cmd === 'mcp') {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return void process.stdout.write(HELP);
  if (cmd === '-v' || cmd === '--version') return void process.stdout.write(`${VERSION}\n`);

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      'base-url': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      'expect-text': { type: 'string' },
      'no-redact': { type: 'boolean' },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error(`Missing <recording> path.\n\n${HELP}`);
  const session = await loadSessionFile(path.resolve(file));
  const num = (v?: string) => (v === undefined ? undefined : Number(v));
  const flow = extractFlow(session, { fromMs: num(values.from), toMs: num(values.to) });
  const list = (v?: string) => v?.split(',').map((s) => s.trim()).filter(Boolean);

  if (cmd === 'summarize') return void process.stdout.write(`${summarizeFlow(flow)}\n`);
  if (cmd === 'generate') {
    const result = generateTest(flow, {
      baseUrl: values['base-url'],
      includeSteps: list(values.include),
      excludeSteps: list(values.exclude),
      expectVisibleText: values['expect-text'],
      redactPii: !values['no-redact'],
    });
    if (values.out) {
      const out = path.resolve(values.out);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, result.code, 'utf8');
      process.stderr.write(`wrote ${path.relative(process.cwd(), out)} (${result.stepCount} steps)\n`);
    } else process.stdout.write(result.code);
    return;
  }
  throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
}

main().catch((err) => {
  process.stderr.write(`bugprint: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
