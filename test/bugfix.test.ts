// Regression tests for bugs found by code review and by replaying a real third-party app.
import { describe, expect, it } from 'vitest';
import { rewriteJsonStrings } from '../src/codegen/json-rewrite.js';
import { fixturesName } from '../src/codegen/output.js';
import { redactBody } from '../src/codegen/redact.js';
import { isSensitiveKey, redactSecrets } from '../src/codegen/secrets.js';
import { generateTest } from '../src/codegen/test.js';
import { extractFlow } from '../src/flow/extract.js';
import { isSensitiveKey as recorderIsSensitive } from '../src/recorder/plugin.js';
import { createSession, parseEvents } from '../src/session/load.js';
import { matchRecordedError } from '../src/verify/run.js';
import { byAttr, doc, h, plugin, Rec } from './helpers.js';

const flowOf = (r: Rec) => extractFlow(createSession(parseEvents(r.events), 'test'));

describe('recorded data stays byte-identical', () => {
  const body = '{"id": 1234567890123456789, "price": 1.50, "big": 1e3, "token": "abc", "email": "jane@corp.io", "list": [1, "x"]}';

  it('rewriteJsonStrings only touches the strings it changes', () => {
    expect(rewriteJsonStrings(body, (v) => v)).toBe(body);
    expect(rewriteJsonStrings(body, (v, keys) => (keys.at(-1) === 'token' ? 'redacted' : v))).toBe(body.replace('"abc"', '"redacted"'));
    expect(rewriteJsonStrings('{"a": "\\u0041\\"b"}', (v) => v + '!')).toBe('{"a": "A\\"b!"}');
    expect(rewriteJsonStrings('{"a": 1,}', (v) => v)).toBeNull();
    expect(rewriteJsonStrings('not json', (v) => v)).toBeNull();
  });

  it('secret redaction keeps 64-bit ids and number formats (regression: JSON round trip)', () => {
    const r = redactSecrets(body, 'application/json');
    expect(r.value).toContain('1234567890123456789');
    expect(r.value).toContain('1.50');
    expect(r.value).toContain('1e3');
    expect(r.value).toContain('"token": "redacted"');
    expect(r.count).toBe(1);
  });

  it('e-mail redaction keeps everything else, including string-typed numbers in storage', () => {
    expect(redactBody(body)).toBe(body.replace('jane@corp.io', 'user@example.com'));
    expect(redactBody('2.10')).toBe('2.10');
    expect(redactBody('1e3')).toBe('1e3');
  });
});

describe('secret key words', () => {
  it('cookieConsent is not a secret anymore; the recorder agrees', () => {
    for (const k of ['cookieConsent', 'cookies_accepted']) {
      expect(isSensitiveKey(k), k).toBe(false);
      expect(recorderIsSensitive(k), k).toBe(false);
    }
    expect(isSensitiveKey('sessionCookie')).toBe(false);
    expect(isSensitiveKey('session_id')).toBe(true);
  });
});

describe('programmatic input is not user input (regression: real app re-renders)', () => {
  function app() {
    const root = doc(h('input', { placeholder: 'New todo', k: 'new' }), h('ul', { k: 'list' }), h('button', { k: 'other' }, 'Other'));
    return root;
  }

  it('drops value/checked changes on elements that do not have focus', () => {
    const root = app();
    const input = byAttr(root, 'k', 'new').id;
    const list = byAttr(root, 'k', 'list').id;
    const row = h('li', {}, h('input', { type: 'checkbox', k: 'toggle' }), h('input', { k: 'edit' }));
    const r = new Rec().page('https://app.test/', root).click(input).type(input, 'milk');
    r.mutate({ adds: [{ parentId: list, nextId: null, node: row }] });
    r.input(byAttr(row, 'k', 'toggle').id, 'on', false); // framework sets .checked = false
    r.input(byAttr(row, 'k', 'edit').id, 'milk'); // framework sets .value
    expect(flowOf(r).steps.map((s) => s.kind)).toEqual(['goto', 'fill']);
  });

  it('keeps input on a field focused before the recording started (autofocus), but not toggles', () => {
    const root = doc(h('input', { k: 'q' }), h('input', { type: 'checkbox', k: 'c' }));
    const r = new Rec()
      .page('https://app.test/', root)
      .type(byAttr(root, 'k', 'q').id, 'abc')
      .input(byAttr(root, 'k', 'c').id, 'on', true);
    expect(flowOf(r).steps.map((s) => s.kind)).toEqual(['goto', 'fill']);
  });

  it('uses the recorder plugin initial focus and rrweb userTriggered when present', () => {
    const root = doc(h('input', { k: 'a' }), h('input', { k: 'b' }));
    const a = byAttr(root, 'k', 'a').id;
    const b = byAttr(root, 'k', 'b').id;
    const r = new Rec().page('https://app.test/', root);
    plugin(r, 'bugprint/interaction@1', { type: 'focus', id: a });
    r.input(b, 'programmatic').input(a, 'typed');
    r.push(3, { source: 5, id: b, text: 'real', isChecked: false, userTriggered: true }, 10);
    r.push(3, { source: 5, id: a, text: 'fake', isChecked: false, userTriggered: false }, 10);
    const fills = flowOf(r)
      .steps.filter((s) => s.kind === 'fill')
      .map((s) => ('value' in s ? s.value : ''));
    expect(fills).toEqual(['typed', 'real']);
  });

  it('a label click focuses its control', () => {
    const root = doc(h('label', { k: 'l' }, 'Done ', h('input', { type: 'checkbox', k: 'cb' })), h('input', { k: 'other' }));
    const r = new Rec()
      .page('https://app.test/', root)
      .click(byAttr(root, 'k', 'other').id)
      .click(byAttr(root, 'k', 'l').id);
    r.input(byAttr(root, 'k', 'cb').id, 'on', true);
    // The click on "other" is a real step; the label click is folded into the check it caused.
    expect(flowOf(r).steps.map((s) => s.kind)).toEqual(['goto', 'click', 'check']);
  });
});

describe('extraction edge cases', () => {
  it('a popstate the recorder could not classify, with no click before it, is the Back button', () => {
    const root = doc(h('p', {}, 'x'));
    const r = new Rec().page('https://app.test/b', root);
    plugin(r, 'bugprint/interaction@1', { type: 'nav', href: 'https://app.test/a', via: 'pop' }, 6000);
    expect(flowOf(r).steps.map((s) => s.kind)).toEqual(['goto', 'back']);
  });

  it('network entries without a status are not failures; console plugins under any name are read', () => {
    const root = doc(h('p', {}, 'x'));
    const r = new Rec().page('https://app.test/', root);
    plugin(r, 'rrweb/network@1', { requests: [{ name: '/api/a', method: 'GET', initiatorType: 'fetch' }] });
    plugin(r, 'acme/console-capture@2', { level: 'error', trace: [], payload: ['"boom"'] });
    const flow = flowOf(r);
    expect(flow.signals.map((s) => s.kind)).toEqual(['console-error']);
  });

  it('segments keyed by id are merged, duplicated full snapshots removed cheaply', () => {
    const snap = { type: 2, timestamp: 2, data: { node: doc() } };
    const events = parseEvents({
      segments: {
        '0': [{ type: 4, timestamp: 1, data: { href: 'https://a.test/' } }, snap],
        '1': [{ type: 3, timestamp: 3, data: { source: 1, positions: [] } }, snap],
      },
    });
    expect(events.map((e) => e.timestamp)).toEqual([1, 2, 3]);
  });
});

describe('generated code', () => {
  function withNetwork(url: string) {
    const root = doc(
      h(
        'ul',
        {},
        h('li', {}, h('h3', {}, 'A'), h('button', { k: 'a' }, 'Delete')),
        h('li', {}, h('h3', {}, 'B'), h('button', { k: 'b' }, 'Delete')),
      ),
    );
    const r = new Rec().page('https://app.test/', root).click(byAttr(root, 'k', 'b').id);
    plugin(r, 'rrweb/network@1', { requests: [{ name: url, method: 'GET', initiatorType: 'fetch', status: 200, responseBody: 'ok' }] });
    return flowOf(r);
  }

  it('hovers the row before clicking a control scoped to it', () => {
    const code = generateTest(withNetwork('/api/x'), { freezeTime: false }).code;
    expect(code).toMatch(
      /await page\.getByRole\('listitem'\)\.filter\(\{ hasText: 'B' \}\)\.hover\(\);\n\s+await page\.getByRole\('listitem'\)\.filter\(\{ hasText: 'B' \}\)\.getByRole\('button', \{ name: 'Delete' \}\)\.click\(\);/,
    );
  });

  it('response keys never include the #fragment', () => {
    expect(generateTest(withNetwork('https://api.other.test/x?y=1#frag')).code).toContain('"url":"https://api.other.test/x?y=1"');
  });

  it('page errors are reported live, before the final assertion', () => {
    const root = doc(h('button', { k: 'b' }, 'Pay'));
    const r = new Rec()
      .page('https://app.test/', root)
      .click(byAttr(root, 'k', 'b').id)
      .error('Uncaught TypeError: x');
    const code = generateTest(flowOf(r)).code;
    expect(code.indexOf('test.info().annotations.push(observed)')).toBeLessThan(code.indexOf('// s1 ·'));
  });

  it('fixturesName handles every test file naming', () => {
    expect(['a/checkout.spec.ts', 'repro.ts', 'x.test.mjs', 'y.spec.tsx'].map(fixturesName)).toEqual([
      'checkout.responses.json',
      'repro.responses.json',
      'x.responses.json',
      'y.responses.json',
    ]);
  });
});

describe('verdict matching', () => {
  it('an empty recorded message never matches (regression: includes("") is always true)', () => {
    expect(matchRecordedError(['', 'Uncaught Error: '], ['anything at all'])).toBeUndefined();
    expect(matchRecordedError(['Uncaught (in promise) TypeError: x is null'], ['x is null'])).toBe(
      'Uncaught (in promise) TypeError: x is null',
    );
  });
});
