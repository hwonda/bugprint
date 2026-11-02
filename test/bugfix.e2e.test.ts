// Real-browser regression tests for bugs found by code review and by replaying a real app.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { generateTest } from '../src/codegen/test.js';
import { extractFlow } from '../src/flow/extract.js';
import { createSession, loadSessionFile, parseEvents } from '../src/session/load.js';
import { verifyTest } from '../src/verify/run.js';

const root = path.resolve(__dirname, '..');
const RUNNER = path.join(root, 'node_modules', '@playwright', 'test', 'index.mjs');

async function tmp(prefix: string) {
  await mkdir(path.join(root, 'test', '.tmp'), { recursive: true });
  return mkdtemp(path.join(root, 'test', '.tmp', prefix));
}

describe('verify', () => {
  it('still reports "reproduced" when the crash makes a later step fail first (regression: annotation only at the end)', async () => {
    const flow = extractFlow(await loadSessionFile(path.join(root, 'fixtures/checkout-bug.json')));
    const dir = await tmp('e2e-mid-');
    const file = path.join(dir, 'mid.spec.ts');
    const code = generateTest(flow, { baseUrl: 'http://localhost:4173' }).code.replace(
      "  await page.getByTestId('place-order').click();\n",
      "  await page.getByTestId('place-order').click();\n  test.setTimeout(10_000);\n  await page.getByText('Order placed!').click({ timeout: 3000 }); // never appears: the page crashed\n",
    );
    await writeFile(file, code);
    const r = await verifyTest(file, { cwd: root });
    expect(r.verdict, r.error).toBe('reproduced');
  }, 90_000);

  for (const ext of ['ts', 'mjs', 'cjs', 'mts']) {
    it(`loads a playwright.config.${ext} with a setup project dependency`, async () => {
      const dir = await tmp(`cfg-${ext}-`);
      await mkdir(path.join(dir, 'setup'));
      await mkdir(path.join(dir, 'repro'));
      // The setup project writes a marker; the chosen project's test checks it exists.
      await writeFile(
        path.join(dir, 'setup', 'auth.setup.ts'),
        `import { test } from ${JSON.stringify(RUNNER)};\nimport { writeFileSync } from 'node:fs';\ntest('auth', () => writeFileSync(${JSON.stringify(path.join(dir, 'marker'))}, 'ok'));\n`,
      );
      await writeFile(
        path.join(dir, 'repro', 'x.spec.ts'),
        `import { test, expect } from ${JSON.stringify(RUNNER)};\nimport { existsSync } from 'node:fs';\ntest('x', () => expect(existsSync(${JSON.stringify(path.join(dir, 'marker'))})).toBe(true));\n`,
      );
      const body = `{ testDir: 'setup', projects: [{ name: 'chromium', dependencies: ['setup'] }, { name: 'setup', testMatch: /.*\\.setup\\.ts/ }] }`;
      const src = ext === 'cjs' ? `module.exports = ${body};\n` : `export default ${body};\n`;
      await writeFile(path.join(dir, `playwright.config.${ext}`), src);
      const r = await verifyTest(path.join(dir, 'repro', 'x.spec.ts'), { cwd: dir, timeoutMs: 60_000 });
      expect(r.verdict, `${r.summary}\n${r.error}`).toBe('passed');
    }, 90_000);
  }
});

describe('generated tests in a real browser', () => {
  it('mocked cross-origin responses pass CORS, including the preflight', async () => {
    const root0 = {
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: 'html',
          attributes: {},
          childNodes: [{ type: 2, id: 3, tagName: 'body', attributes: {}, childNodes: [] }],
        },
      ],
    };
    const t = 1_700_000_000_000;
    const events = [
      { type: 4, timestamp: t, data: { href: 'http://localhost:4173/' } },
      { type: 2, timestamp: t + 1, data: { node: root0 } },
      {
        type: 6,
        timestamp: t + 2,
        data: {
          plugin: 'rrweb/network@1',
          payload: {
            requests: [
              {
                name: 'http://127.0.0.1:4199/api/x',
                method: 'GET',
                initiatorType: 'fetch',
                status: 200,
                responseHeaders: { 'content-type': 'text/plain' },
                responseBody: 'hello from the recording',
              },
            ],
          },
        },
      },
    ];
    const flow = extractFlow(createSession(parseEvents(events), 'cors'));
    const dir = await tmp('e2e-cors-');
    const file = path.join(dir, 'cors.spec.ts');
    const code = generateTest(flow, { freezeTime: false }).code.replace(
      '  // TODO: no error was recorded.',
      "  const text = await page.evaluate(() => fetch('http://127.0.0.1:4199/api/x', { credentials: 'include', headers: { 'x-custom': '1' } }).then((r) => r.text()));\n  expect(text).toBe('hello from the recording');\n  // TODO: no error was recorded.",
    );
    await writeFile(file, code);
    const r = await verifyTest(file, { cwd: root });
    expect(r.verdict, r.error).toBe('passed');
  }, 90_000);

  it('controls shown only on row hover can be clicked on replay (regression: real TodoMVC)', async () => {
    const html = `<style>li button{display:none} li:hover button{display:inline}</style>
      <ul>${['milk', 'eggs'].map((n) => `<li><span>${n}</span><button aria-label="Delete" onclick="document.body.dataset.deleted='${n}'">×</button></li>`).join('')}</ul>`;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html);
    await page.addScriptTag({ path: path.join(root, 'node_modules/rrweb/dist/rrweb.umd.min.cjs') });
    await page.evaluate(() => {
      const w = window as unknown as { __ev: unknown[]; rrweb: { record: (o: unknown) => void } };
      w.__ev = [{ type: 4, timestamp: Date.now(), data: { href: 'http://localhost/' } }];
      w.rrweb.record({ emit: (e: unknown) => w.__ev.push(e) });
    });
    await page.getByRole('listitem').filter({ hasText: 'eggs' }).hover();
    await page.getByRole('listitem').filter({ hasText: 'eggs' }).getByRole('button', { name: 'Delete' }).click();
    const events = await page.evaluate(() => (window as unknown as { __ev: unknown[] }).__ev);
    const step = extractFlow(createSession(parseEvents(events), 'hover')).steps.find((s) => s.kind === 'click');
    expect(step && 'target' in step && step.target.hoverCode).toBeTruthy();

    // Replay on a fresh page: hover the row (as generated), then click the control.
    const fresh = await browser.newPage();
    await fresh.setContent(html);
    const run = (code: string) => new Function('page', `return ${code};`)(fresh);
    if (step && 'target' in step) {
      await run(`${step.target.hoverCode}.hover()`);
      await run(`${step.target.code}.click({ timeout: 3000 })`);
    }
    expect(await fresh.evaluate(() => document.body.dataset.deleted)).toBe('eggs');
    await browser.close();
  }, 60_000);
});
