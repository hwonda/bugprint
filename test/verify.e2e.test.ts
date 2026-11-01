// Runs real browsers against the demo shop. ~10s.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateTest } from '../src/codegen/test.js';
import { extractFlow } from '../src/flow/extract.js';
import { loadSessionFile } from '../src/session/load.js';
import { verifyTest } from '../src/verify/run.js';

const root = path.resolve(__dirname, '..');

async function writeRepro(name: string, mutate: (code: string) => string = (c) => c) {
  const flow = extractFlow(await loadSessionFile(path.join(root, 'fixtures/checkout-bug.json')));
  // Not under test-results/: the runner wipes that folder before each run.
  await mkdir(path.join(root, 'test', '.tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test', '.tmp', 'e2e-'));
  const file = path.join(dir, `${name}.spec.ts`);
  await writeFile(file, mutate(generateTest(flow, { baseUrl: 'http://localhost:4173' }).code));
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
});
