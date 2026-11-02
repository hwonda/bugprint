import { beforeEach, describe, expect, it } from 'vitest';
import { generateTest } from '../src/codegen/test.js';
import { redactBody } from '../src/codegen/redact.js';
import { extractFlow } from '../src/flow/extract.js';
import { createSession, parseEvents } from '../src/session/load.js';
import { parseMeta, stepAt } from '../src/verify/run.js';
import { byAttr, doc, h, plugin, Rec, resetIds } from './helpers.js';

beforeEach(resetIds);
const flowOf = (r: Rec) => extractFlow(createSession(parseEvents(r.events), 'test'));
const NET = 'rrweb/network@1';
const UI = 'bugprint/interaction@1';

describe('interaction plugin', () => {
  it('records Enter as a press on the focused field and drops the synthetic click it causes', () => {
    const root = doc(h('form', {}, h('input', { 'aria-label': 'Search', k: 'q' }), h('button', { k: 'go' }, 'Go')));
    const q = byAttr(root, 'k', 'q').id;
    const r = new Rec().page('https://app.test/', root).click(q).type(q, 'cats');
    plugin(r, UI, { type: 'key', key: 'Enter', id: q });
    r.push(3, { source: 2, type: 2, id: byAttr(root, 'k', 'go').id }, 5); // implicit submit clicks the default button
    const flow = flowOf(r);
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'fill', 'press']);
    expect(generateTest(flow, { freezeTime: false }).code).toContain("await page.getByLabel('Search').press('Enter');");
    expect(flow.capabilities.interaction).toBe(true);
  });

  it('presses on the page when the key target is the body', () => {
    const root = doc(h('p', {}, 'x'));
    const body = root.childNodes![0]!.childNodes![1]!.id;
    const flow = flowOf(plugin(new Rec().page('https://app.test/', root), UI, { type: 'key', key: 'Control+k', id: body }));
    expect(generateTest(flow, { freezeTime: false }).code).toContain("await page.keyboard.press('Control+k');");
  });

  it('turns client-side navigation into URL expectations and back/forward', () => {
    const root = doc(h('a', { href: '/b', k: 'l' }, 'B'));
    const r = new Rec().page('https://app.test/a', root).click(byAttr(root, 'k', 'l').id);
    plugin(r, UI, { type: 'nav', href: 'https://app.test/b', via: 'push' });
    plugin(r, UI, { type: 'nav', href: 'https://app.test/a', via: 'back' }, 2000);
    const flow = flowOf(r);
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'click', 'expectUrl', 'back']);
    expect(flow.pages).toEqual(['https://app.test/a', 'https://app.test/b']);
    const code = generateTest(flow, { freezeTime: false }).code;
    expect(code).toContain("await expect(page).toHaveURL(BASE_URL + '/b');");
    expect(code).toContain('await page.goBack();');
  });
});

describe('network', () => {
  const req = (over: Record<string, unknown>) => ({
    name: 'https://app.test/api/me',
    method: 'GET',
    initiatorType: 'fetch',
    status: 200,
    responseHeaders: { 'Content-Type': 'application/json' },
    responseBody: { email: 'jane@corp.io', id: 1234567890123 },
    ...over,
  });

  function recording() {
    const root = doc(h('button', { k: 'b' }, 'Load'));
    const r = new Rec().page('https://app.test/', root).click(byAttr(root, 'k', 'b').id);
    plugin(r, NET, {
      requests: [
        req({}),
        req({ name: '/logo.png', initiatorType: 'img' }),
        req({ name: 'https://cdn.other/x', responseBody: 'hi', responseHeaders: {} }),
      ],
    });
    plugin(r, NET, { requests: [req({ name: '/api/save', method: 'POST', status: 503, responseBody: null })] });
    return r;
  }

  it('keeps fetch/XHR calls, resolves URLs and flags server errors', () => {
    const flow = flowOf(recording());
    expect(flow.network.map((c) => `${c.method} ${c.url} ${c.status}`)).toEqual([
      'GET https://app.test/api/me 200',
      'GET https://cdn.other/x 200',
      'POST https://app.test/api/save 503',
    ]);
    expect(flow.signals).toMatchObject([{ kind: 'network-error', message: 'POST /api/save → 503' }]);
  });

  it('serves recorded responses, redacting e-mails but keeping ids', () => {
    const t = generateTest(flowOf(recording()));
    expect(t.mockedResponses).toBe(2);
    expect(t.code).toContain('await serveRecordedResponses(page, RECORDED_RESPONSES);');
    expect(t.code).toContain('\\"email\\":\\"user@example.com\\"');
    expect(t.code).toContain('1234567890123');
    expect(t.code).toContain('"url":"https://cdn.other/x"'); // cross-origin stays absolute
    expect(t.notes.join()).toMatch(/1 recorded API call\(s\) have no response body/);
  });

  it('can be turned off, and warns when the recording has no network data at all', () => {
    expect(generateTest(flowOf(recording()), { mockNetwork: false }).code).not.toContain('RECORDED_RESPONSES');
    const root = doc(h('p', {}, 'x'));
    const t = generateTest(flowOf(new Rec().page('https://app.test/', root)));
    expect(t.notes.join()).toMatch(/no network data/);
  });

  it('redactBody only touches strings', () => {
    expect(redactBody('{"a":"x y@z.io","n":4111111111111111}', 'application/json')).toBe('{"a":"x user@example.com","n":4111111111111111}');
    expect(redactBody('mail a@b.co', 'text/plain')).toBe('mail user@example.com');
  });
});

describe('clock and metadata', () => {
  it('installs the clock at the recording time and embeds the recorded errors', () => {
    const root = doc(h('button', { k: 'b' }, 'Pay'));
    const r = new Rec()
      .page('https://app.test/', root)
      .click(byAttr(root, 'k', 'b').id)
      .error('Uncaught (in promise) TypeError: boom');
    const flow = flowOf(r);
    const { code, testName } = generateTest(flow);
    expect(code).toContain(`await page.clock.install({ time: new Date('${new Date(flow.recordedAt).toISOString()}') });`);
    expect(testName).toBe('repro: TypeError: boom');
    expect(parseMeta(code)).toEqual({ v: 1, session: flow.sessionId, errors: ['Uncaught (in promise) TypeError: boom'] });
    expect(generateTest(flow, { freezeTime: false }).code).not.toContain('clock');
  });

  it('maps a failing line back to its step', () => {
    const src = [
      'test(x, async () => {',
      '  // s1 · open /',
      "  await page.goto('/');",
      '  // s2 · click button "Pay"',
      '  await x.click();',
      '',
      '  // Recorded in the session:',
      '  expect(1)',
      '});',
    ].join('\n');
    expect(stepAt(src, 5)).toEqual({ id: 's2', description: 'click button "Pay"', line: 5 });
    expect(stepAt(src, 3)?.id).toBe('s1');
    expect(stepAt(src, 8)).toBeUndefined(); // the final assertion is not a step
  });
});
