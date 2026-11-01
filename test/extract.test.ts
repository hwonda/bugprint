import { beforeEach, describe, expect, it } from 'vitest';
import { generateTest } from '../src/codegen/test.js';
import { redactValue } from '../src/codegen/redact.js';
import { extractFlow } from '../src/flow/extract.js';
import { summarizeFlow } from '../src/flow/summarize.js';
import { createSession, parseEvents } from '../src/session/load.js';
import { byAttr, doc, h, Rec, resetIds } from './helpers.js';

beforeEach(resetIds);
const flowOf = (r: Rec) => extractFlow(createSession(parseEvents(r.events), 'test'));

function loginPage() {
  return doc(
    h('form', {},
      h('label', { for: 'u' }, 'Username'), h('input', { id: 'u' }),
      h('label', { for: 'p' }, 'Password'), h('input', { id: 'p', type: 'password' }),
      h('select', { 'aria-label': 'Plan', k: 'plan' }, h('option', { value: 'free' }, 'Free'), h('option', { value: 'pro' }, 'Pro')),
      h('label', {}, h('input', { type: 'checkbox', k: 'tos' }), 'Accept'),
      h('button', { type: 'submit' }, 'Sign in'),
    ),
  );
}

describe('extractFlow', () => {
  it('collapses keystrokes, drops focus clicks and label clicks, and keeps the final value', () => {
    const root = loginPage();
    const u = byAttr(root, 'id', 'u').id;
    const tos = byAttr(root, 'k', 'tos');
    const tosLabel = root.childNodes![0]!.childNodes![1]!.childNodes![0]!.childNodes![5]!; // <label> wrapping the checkbox
    const r = new Rec().page('https://app.test/login', root).click(u).type(u, 'jane').input(u, 'jan').input(u, 'janet');
    r.click(tosLabel.id).input(tos.id, 'on', true);
    const flow = flowOf(r);
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'fill', 'check']);
    expect(flow.steps[1]).toMatchObject({ kind: 'fill', value: 'janet' });
  });

  it('marks password values as masked and never emits them', () => {
    const root = loginPage();
    const p = byAttr(root, 'id', 'p').id;
    const r = new Rec().page('https://app.test/login', root).click(p).input(p, '********');
    const flow = flowOf(r);
    expect(flow.steps[1]).toMatchObject({ kind: 'fill', masked: true });
    const { code, secrets } = generateTest(flow);
    expect(code).toContain("fill(process.env.BUGPRINT_SECRET_1 ?? '')");
    expect(code).not.toContain('********');
    expect(secrets).toEqual(['BUGPRINT_SECRET_1']);
  });

  it('turns select inputs into selectOption', () => {
    const root = loginPage();
    const sel = byAttr(root, 'k', 'plan').id;
    const flow = flowOf(new Rec().page('https://app.test/login', root).click(sel).input(sel, 'pro'));
    expect(flow.steps.at(-1)).toMatchObject({ kind: 'select', value: 'pro' });
    expect(generateTest(flow).code).toContain("page.getByLabel('Plan').selectOption('pro')");
  });

  it('treats a page load right after a click as navigation, and a later one as goto', () => {
    const a = doc(h('a', { href: '/b', k: 'l' }, 'Next'));
    const link = byAttr(a, 'k', 'l').id;
    const b = doc(h('p', {}, 'B'));
    const r = new Rec().page('https://app.test/a', a).click(link).page('https://app.test/b', b);
    r.push(0, {}, 10_000);
    r.page('https://app.test/c', doc(h('p', {}, 'C')));
    const flow = flowOf(r);
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'click', 'expectUrl', 'goto']);
  });

  it('does not treat a periodic re-snapshot of the same page as a reload', () => {
    const root = doc(h('p', {}, 'x'));
    const r = new Rec().page('https://app.test/', root);
    r.push(4, { href: 'https://app.test/' }, 5000).push(2, { node: root }, 1);
    expect(flowOf(r).steps.map((s) => s.kind)).toEqual(['goto']);
  });

  it('tracks DOM mutations so elements added later can be located', () => {
    const root = doc(h('div', { id: 'app' }));
    const app = byAttr(root, 'id', 'app').id;
    const dialog = h('div', { role: 'dialog', 'aria-label': 'Confirm' }, h('button', { k: 'ok' }, 'Delete'));
    const r = new Rec().page('https://app.test/', root).mutate({ adds: [{ parentId: app, nextId: null, node: dialog }] });
    r.click(byAttr(dialog, 'k', 'ok').id);
    expect(flowOf(r).steps[1]).toMatchObject({ target: { code: "page.getByRole('button', { name: 'Delete' })" } });
  });

  it('attributes errors to the preceding step and asserts on them', () => {
    const root = doc(h('button', {}, 'Pay'));
    const btn = root.childNodes![0]!.childNodes![1]!.childNodes![0]!.id;
    const r = new Rec().page('https://app.test/pay', root).click(btn).error('Uncaught TypeError: x is undefined', ['pay.js:1:1']);
    const flow = flowOf(r);
    expect(flow.signals).toMatchObject([{ kind: 'uncaught-error', afterStepId: 's2', message: 'Uncaught TypeError: x is undefined' }]);
    expect(summarizeFlow(flow)).toContain('⚠ uncaught-error');
    const { code, testName } = generateTest(flow, { baseUrl: 'http://localhost:3000' });
    expect(testName).toBe('repro: TypeError: x is undefined');
    expect(code).toContain("process.env.BUGPRINT_BASE_URL ?? 'http://localhost:3000'");
    expect(code).toContain("await page.goto(BASE_URL + '/pay');");
    expect(code).toContain('toEqual([])');
  });

  it('honours step windows and include/exclude lists', () => {
    const root = doc(h('button', { k: 'a' }, 'A'), h('button', { k: 'b' }, 'B'));
    const r = new Rec().page('https://app.test/', root).click(byAttr(root, 'k', 'a').id, 1000).click(byAttr(root, 'k', 'b').id, 1000);
    const session = createSession(parseEvents(r.events), 't');
    const windowed = extractFlow(session, { fromMs: 1900 });
    expect(windowed.steps.map((s) => s.kind)).toEqual(['goto', 'click']);
    expect(windowed.warnings.join()).toMatch(/dropped/);
    const full = extractFlow(session);
    const code = generateTest(full, { excludeSteps: ['s2'] }).code;
    expect(code).not.toContain("name: 'A'");
    expect(code).toContain("name: 'B'");
  });
});

describe('redactValue', () => {
  it('keeps the shape of PII', () => {
    expect(redactValue('mail me: jane.doe@corp.io')).toBe('mail me: user@example.com');
    expect(redactValue('4111 1111 1111 1111')).toBe('4242 4242 4242 4242');
    expect(redactValue('010-1234-5678')).toBe('010-0000-0000');
    expect(redactValue('order 2026-11-01')).toBe('order 2026-11-01');
    expect(redactValue('save20')).toBe('save20');
  });
});

describe('parseEvents', () => {
  it('accepts arrays, {events} and NDJSON, and rejects recordings without a snapshot', () => {
    const e = [{ type: 2, timestamp: 2, data: { node: doc() } }, { type: 4, timestamp: 1, data: {} }];
    expect(parseEvents(e).map((x) => x.timestamp)).toEqual([1, 2]);
    expect(parseEvents({ events: e })).toHaveLength(2);
    expect(parseEvents(e.map((x) => JSON.stringify(x)).join('\n'))).toHaveLength(2);
    expect(() => parseEvents([{ type: 4, timestamp: 1, data: {} }])).toThrow(/full DOM snapshot/);
  });
});
