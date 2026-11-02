// Records tricky pages with rrweb in a real browser, lets bugprint pick a locator for
// each clicked element, then asks the real test runner which elements that locator
// matches. They must agree: exactly one element, the one that was clicked.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFlow } from '../src/flow/extract.js';
import { createSession, parseEvents } from '../src/session/load.js';

const root = path.resolve(__dirname, '..');
const RRWEB = readFileSync(path.join(root, 'node_modules/rrweb/dist/rrweb.umd.min.cjs'), 'utf8');
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

const PAGES: Record<string, string> = {
  'substring headings': `<ul>${Array.from({ length: 12 }, (_, i) => `<li><h3>Product ${i}</h3><button data-k="p${i}">Add to cart</button></li>`).join('')}</ul>`,
  'exact vs prefix names': `<button data-k="save">Save</button><button data-k="draft">Save draft</button><button data-k="as">Save as…</button>`,
  'labels and placeholders': `
    <label for="e">Email</label><input id="e" data-k="email">
    <label>Work email <input data-k="work"></label>
    <input placeholder="Search" data-k="search">
    <label><input type="checkbox" data-k="tos"> I agree</label>`,
  'hidden duplicates and aria': `
    <div hidden><button data-k="h">Pay</button></div><button data-k="pay">Pay</button>
    <button aria-label="Close dialog" data-k="x">×</button>
    <span id="lbl">Quantity</span><input aria-labelledby="lbl" data-k="qty">`,
  'quotes and nested text': `<a href="#" data-k="q">Don't <b>stop</b> me</a><table><tr><td>Alice</td><td><button data-k="a">Edit</button></td></tr><tr><td>Bob</td><td><button data-k="b">Edit</button></td></tr></table>`,
  'non-semantic clickables': `<div class="card"><span>Plan A</span><div data-k="ca" onclick="">Choose</div></div><div class="card"><span>Plan B</span><div data-k="cb" onclick="">Choose</div></div>`,
};

async function recordClicks(page: Page, html: string) {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  await page.addScriptTag({ content: RRWEB });
  await page.evaluate(() => {
    const w = window as unknown as { __ev: unknown[]; rrweb: { record: (o: unknown) => void } };
    w.__ev = [{ type: 4, timestamp: Date.now(), data: { href: 'http://localhost/test' } }];
    w.rrweb.record({ emit: (e: unknown) => w.__ev.push(e) });
  });
  const keys = await page.$$eval('[data-k]', (els) => els.filter((e) => !e.closest('[hidden]')).map((e) => (e as HTMLElement).dataset.k!));
  for (const k of keys) await page.locator(`[data-k="${k}"]`).click({ force: true });
  await page.waitForTimeout(50);
  const events = await page.evaluate(() => (window as unknown as { __ev: unknown[] }).__ev);
  return { keys, events };
}

describe('generated locators agree with the real test runner', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    it(
      // oxlint-disable-next-line vitest/valid-title -- titles come from the PAGES table
      name,
      async () => {
        const page = await browser.newPage();
        const { keys, events } = await recordClicks(page, html);
        const flow = extractFlow(createSession(parseEvents(events), name));
        const targets = flow.steps.filter((s) => 'target' in s && s.target).map((s) => (s as { target: { code: string } }).target.code);
        expect(targets.length, `steps: ${flow.steps.map((s) => s.kind)}`).toBe(keys.length);
        for (const [i, code] of targets.entries()) {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const locator = new Function('page', `return ${code};`)(page);
          const matched: string[] = await locator.evaluateAll((els: HTMLElement[]) =>
            els.map((e) => e.closest('[data-k]')?.getAttribute('data-k') ?? '?'),
          );
          expect(matched, `${keys[i]} → ${code}`).toEqual([keys[i]]);
        }
        await page.close();
      },
      30_000,
    );
  }
});
