// Runs real browsers against the demo shop. ~10s.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateTest, type GenerateOptions } from '../src/codegen/test.js';
import { minimizeRepro } from '../src/minimize/minimize.js';
import { extractFlow } from '../src/flow/extract.js';
import { loadSessionFile } from '../src/session/load.js';
import { verifyTest } from '../src/verify/run.js';

const root = path.resolve(__dirname, '..');

async function writeRepro(name: string, mutate: (code: string) => string = (c) => c, gen: GenerateOptions = {}) {
  const flow = extractFlow(await loadSessionFile(path.join(root, 'fixtures/checkout-bug.json')));
  // Not under test-results/: the runner wipes that folder before each run.
  await mkdir(path.join(root, 'test', '.tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test', '.tmp', 'e2e-'));
  const file = path.join(dir, `${name}.spec.ts`);
  await writeFile(file, mutate(generateTest(flow, { baseUrl: 'http://localhost:4173', ...gen }).code));
  return file;
}

describe('verifyTest (real browser)', () => {
  it('reports "reproduced" when the recorded error happens again', async () => {
    const r = await verifyTest(await writeRepro('repro'), { cwd: root });
    expect(r.verdict, r.error).toBe('reproduced');
    expect(r.failedStep).toBeUndefined();
  }, 90_000);

  it('reports "failed-differently" with the failing step when a locator no longer matches', async () => {
    const file = await writeRepro('broken', (c) =>
      c.replace("{ name: 'Apply' }", "{ name: 'Redeem' }").replace('  const errors: string[] = [];', '  test.setTimeout(8000);\n  const errors: string[] = [];'),
    );
    const r = await verifyTest(file, { cwd: root });
    expect(r.verdict, r.error).toBe('failed-differently');
    expect(r.failedStep).toMatchObject({ id: 's11', description: 'click button "Apply"' });
    expect(r.summary).toMatch(/locator did not match/);
  }, 90_000);

  it('does not count an unrelated error as a reproduction (regression: code frame quoted the recorded error)', async () => {
    // Opening checkout and clicking Apply without a code only logs a 404: not the recorded crash.
    const r = await verifyTest(await writeRepro('unrelated', undefined, { includeSteps: ['s8', 's11'] }), { cwd: root });
    expect(r.verdict, r.error).toBe('passed');
  }, 90_000);

  it('minimizes the demo session to the causal steps', async () => {
    const flow = extractFlow(await loadSessionFile(path.join(root, 'fixtures/checkout-bug.json')));
    const r = await minimizeRepro(flow, { cwd: root, baseUrl: 'http://localhost:4173' });
    expect(r.verdict).toBe('minimized');
    expect(r.minimal).toMatchObject({ startFrom: 's8', steps: 4 });
    expect(r.minimal!.description).toEqual([
      's8 · open /checkout.html',
      's10 · type "save20" into field labelled "Coupon code"',
      's11 · click button "Apply"',
      's13 · click [data-testid="place-order"]',
    ]);
    expect(r.code).toContain("await page.goto(BASE_URL + '/checkout.html');");
  }, 240_000);
});
