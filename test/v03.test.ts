import { beforeEach, describe, expect, it } from 'vitest';
import { generateTest, selectSteps } from '../src/codegen/test.js';
import { extractFlow } from '../src/flow/extract.js';
import { split } from '../src/minimize/minimize.js';
import { createSession, parseEvents } from '../src/session/load.js';
import { stripCodeFrame } from '../src/verify/run.js';
import { byAttr, doc, h, plugin, Rec, resetIds } from './helpers.js';

beforeEach(resetIds);
const flowOf = (r: Rec) => extractFlow(createSession(parseEvents(r.events), 'test'));
const UI = 'bugprint/interaction@1';

/** goto / → click A → nav /b → click B → nav /c → click C */
function journey() {
  const page = (k: string) => doc(h('button', { k }, k.toUpperCase()));
  const a = page('a');
  const r = new Rec().page('https://app.test/', a).click(byAttr(a, 'k', 'a').id);
  const b = page('b');
  r.page('https://app.test/b', b).click(byAttr(b, 'k', 'b').id);
  const c = page('c');
  r.page('https://app.test/c', c).click(byAttr(c, 'k', 'c').id);
  return flowOf(r);
}

describe('selectSteps', () => {
  it('startFrom opens that page directly and drops earlier steps', () => {
    const flow = journey();
    expect(flow.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(['s1:goto', 's2:click', 's3:expectUrl', 's4:click', 's5:expectUrl', 's6:click']);
    const steps = selectSteps(flow, { startFrom: 's5' });
    expect(steps.map((s) => `${s.id}:${s.kind}`)).toEqual(['s5:goto', 's6:click']);
    expect(generateTest(flow, { startFrom: 's5', freezeTime: false }).code).toContain("await page.goto(BASE_URL + '/c');");
  });

  it('rejects a non-navigation start step', () => {
    expect(() => selectSteps(journey(), { startFrom: 's4' })).toThrow(/navigation step/);
  });

  it('always starts by opening a page, even when includeSteps drops the first goto', () => {
    const flow = journey();
    expect(selectSteps(flow, { includeSteps: ['s3', 's4'] }).map((s) => `${s.id}:${s.kind}`)).toEqual(['s3:goto', 's4:click']);
    expect(selectSteps(flow, { includeSteps: ['s4'] }).map((s) => `${s.id}:${s.kind}`)).toEqual(['start:goto', 's4:click']);
  });
});

describe('initial storage', () => {
  function withStorage(payload: Record<string, unknown>) {
    const root = doc(h('button', { k: 'b' }, 'Go'));
    const r = new Rec().page('https://app.test/', root);
    plugin(r, UI, { type: 'storage', origin: 'https://app.test', ...payload });
    plugin(r, UI, { type: 'storage', origin: 'https://app.test', localStorage: { later: 'ignored' }, cookies: {}, masked: [] });
    return flowOf(r.click(byAttr(root, 'k', 'b').id));
  }

  it('restores the first snapshot as storageState, redacting e-mails', () => {
    const flow = withStorage({ localStorage: { cart: '["kb"]', profile: '{"email":"jane@corp.io"}' }, cookies: { theme: 'dark' }, masked: ['authToken'] });
    expect(flow.initialStorage?.localStorage).toEqual({ cart: '["kb"]', profile: '{"email":"jane@corp.io"}' });
    const t = generateTest(flow);
    expect(t.code).toContain('test.use({');
    expect(t.code).toContain("{ name: 'cart', value: '[\"kb\"]' }");
    expect(t.code).toContain('user@example.com');
    expect(t.code).not.toContain('jane@corp.io');
    expect(t.code).toContain("{ name: 'theme', value: 'dark', domain: new URL(BASE_URL).hostname");
    expect(t.code).not.toContain('later');
    expect(t.notes.join()).toMatch(/left out sensitive storage entries \(authToken\)/);
  });

  it('emits nothing when storage was empty or restoreStorage is off', () => {
    expect(generateTest(withStorage({ localStorage: {}, cookies: {}, masked: [] })).code).not.toContain('storageState');
    expect(generateTest(withStorage({ localStorage: { a: '1' }, cookies: {}, masked: [] }), { restoreStorage: false }).code).not.toContain('storageState');
  });
});

describe('external fixtures', () => {
  it('moves large recorded responses into a sidecar file', () => {
    const root = doc(h('button', { k: 'b' }, 'Load'));
    const r = new Rec().page('https://app.test/', root).click(byAttr(root, 'k', 'b').id);
    const big = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ i, name: `row ${i}` })) });
    plugin(r, 'rrweb/network@1', { requests: [{ name: 'https://app.test/api/rows', method: 'GET', initiatorType: 'fetch', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: big }] });
    const flow = flowOf(r);
    const inline = generateTest(flow);
    expect(inline.files).toEqual([]);
    expect(inline.notes.join()).toMatch(/separate fixtures file/);
    const ext = generateTest(flow, { fixturesFile: 'rows.responses.json' });
    expect(ext.files.map((f) => f.name)).toEqual(['rows.responses.json']);
    expect(JSON.parse(ext.files[0]!.content)[0].url).toBe('/api/rows');
    expect(ext.code).toContain("readFileSync(path.join(path.dirname(test.info().file), 'rows.responses.json'), 'utf8')");
    expect(ext.code).not.toContain('row 2999');
  });
});

describe('export formats', () => {
  const ev = (t: number, type = 3) => ({ type, timestamp: t, data: type === 2 ? { node: doc() } : { source: 1, positions: [] } });
  it('finds events nested in objects and segments, merging and de-duplicating them', () => {
    const seg1 = [ev(1, 4), ev(2, 2), ev(3)];
    const seg2 = [ev(3), ev(4)]; // overlaps seg1 by one event
    expect(parseEvents({ data: { id: 'x', snapshots: seg1 } })).toHaveLength(3);
    expect(parseEvents({ recording: { meta: [1, 2], segments: [seg2, seg1] } }).map((e) => e.timestamp)).toEqual([1, 2, 3, 4]);
    expect(parseEvents([seg1, seg2].map((s) => JSON.stringify(s)).join('\n'))).toHaveLength(4);
    expect(() => parseEvents({ foo: [{ bar: 1 }] })).toThrow(/No rrweb events/);
  });
});

describe('helpers', () => {
  it('split chunks evenly and in order', () => {
    expect(split([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(split([1, 2, 3], 3)).toEqual([[1], [2], [3]]);
  });

  it('stripCodeFrame drops source excerpts from failure messages', () => {
    const msg = ['Error: boom', '+   "Failed to load resource"', "  32 |   //   TypeError: reading 'rate'", '> 34 |   expect(errors)', '     |   ^', 'at x.ts:34'].join('\n');
    expect(stripCodeFrame(msg)).toBe(['Error: boom', '+   "Failed to load resource"', 'at x.ts:34'].join('\n'));
  });
});

describe('assertion order', () => {
  it('checks recorded errors before the expected text, so a crash is not hidden by a timeout', () => {
    const root = doc(h('button', { k: 'b' }, 'Pay'));
    const r = new Rec().page('https://app.test/', root).click(byAttr(root, 'k', 'b').id).error('Uncaught TypeError: boom');
    const code = generateTest(flowOf(r), { expectVisibleText: 'Paid' }).code;
    expect(code.indexOf('toEqual([])')).toBeGreaterThan(0);
    expect(code.indexOf("getByText('Paid')")).toBeGreaterThan(code.indexOf('toEqual([])'));
  });
});
