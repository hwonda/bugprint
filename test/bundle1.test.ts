import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isSensitiveKey, redactSecrets, redactSecretText } from '../src/codegen/secrets.js';
import { generateTest } from '../src/codegen/test.js';
import { extractFlow } from '../src/flow/extract.js';
import { isSensitiveKey as recorderIsSensitive } from '../src/recorder/plugin.js';
import { createSession, parseEvents } from '../src/session/load.js';
import { sweepStale } from '../src/util/cleanup.js';
import { findConfig, findRunnerCli } from '../src/verify/run.js';
import { byAttr, doc, h, plugin, Rec, resetIds } from './helpers.js';

beforeEach(resetIds);
const flowOf = (r: Rec) => extractFlow(createSession(parseEvents(r.events), 'test'));

const SENSITIVE = ['accessToken', 'refresh_token', 'X-Api-Key', 'apiKey', 'sessionId', 'session_id', 'auth', 'Authorization', 'password', 'client_secret', 'csrfToken', 'jwt', 'privateKey', 'OTP'];
const SAFE = ['author', 'authors', 'tokenizer', 'cart', 'theme', 'sessions_count_label', 'keyboard', 'pinned', 'title', 'email'];

describe('secret detection', () => {
  it('judges keys by their words', () => {
    for (const k of SENSITIVE) expect(isSensitiveKey(k), k).toBe(true);
    for (const k of SAFE) expect(isSensitiveKey(k), k).toBe(false);
  });

  it('the browser recorder uses exactly the same rule', () => {
    for (const k of [...SENSITIVE, ...SAFE]) expect(recorderIsSensitive(k), k).toBe(isSensitiveKey(k));
    expect(recorderIsSensitive('__bugprint_events')).toBe(true);
  });

  it('replaces well-known token formats in free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecretText(`token=${jwt}`)).toBe('token=eyJredacted.eyJredacted.redacted');
    expect(redactSecretText('Authorization: Bearer abcdef1234567890')).toBe('Authorization: Bearer redacted');
    expect(redactSecretText('key sk_live_51Hxxxxxxxxxxxxxx')).toBe('key sk_live_redacted');
    expect(redactSecretText('AKIAIOSFODNN7EXAMPLE')).toBe('AKIAREDACTEDREDACTED');
    expect(redactSecretText('nothing to see, order 1234')).toBe('nothing to see, order 1234');
  });

  it('redacts JSON values under sensitive keys (whole subtree), keeping numbers and other fields', () => {
    const body = JSON.stringify({ user: { id: 7, name: 'Jane', accessToken: 'abc123' }, auth: { refresh: 'r-1', expiresIn: 3600 }, author: 'Kim' });
    const r = redactSecrets(body, 'application/json');
    expect(JSON.parse(r.value)).toEqual({ user: { id: 7, name: 'Jane', accessToken: 'redacted' }, auth: { refresh: 'redacted', expiresIn: 3600 }, author: 'Kim' });
    expect(r.count).toBe(2);
    expect(redactSecrets('{"a":1}', 'application/json')).toEqual({ value: '{"a":1}', count: 0 }); // untouched bodies keep their formatting
  });
});

describe('secrets in generated tests', () => {
  function recording() {
    const root = doc(h('button', { k: 'b' }, 'Login'));
    const r = new Rec().page('https://app.test/', root);
    plugin(r, 'bugprint/interaction@1', { type: 'storage', origin: 'https://app.test', localStorage: { cart: '["kb"]', authToken: 'eyJ.x.y', lastSessionId: 's-9' }, cookies: { theme: 'dark' }, masked: [] });
    r.click(byAttr(root, 'k', 'b').id);
    plugin(r, 'rrweb/network@1', {
      requests: [{ name: 'https://app.test/api/login', method: 'POST', initiatorType: 'fetch', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { accessToken: 'tok-123', user: { id: 1 } } }],
    });
    return flowOf(r);
  }

  it('drops sensitive storage keys and redacts tokens in responses by default', () => {
    const t = generateTest(recording());
    expect(t.code).toContain("{ name: 'cart', value: '[\"kb\"]' }");
    expect(t.code).not.toContain('authToken');
    expect(t.code).not.toContain('lastSessionId');
    expect(t.code).not.toContain('tok-123');
    expect(t.code).toContain('\\"accessToken\\":\\"redacted\\"');
    expect(t.notes.join()).toMatch(/3 secret value\(s\)/);
  });

  it('keepSecrets keeps them', () => {
    const t = generateTest(recording(), { keepSecrets: true });
    expect(t.code).toContain('tok-123');
    expect(t.code).toContain('authToken');
  });

  it('a storageState file replaces recorded cookies and recorded localStorage is layered on top once', () => {
    const t = generateTest(recording(), { storageState: 'auth/user.json' });
    expect(t.code).toContain("test.use({ storageState: process.env.BUGPRINT_STORAGE_STATE ?? 'auth/user.json' });");
    expect(t.code).toContain('await page.addInitScript(');
    expect(t.code).toContain('[["cart","[\\"kb\\"]"]]');
    expect(t.code).not.toContain("name: 'theme'");
    expect(t.notes.join()).toMatch(/Recorded cookies are not applied/);
  });
});

describe('runner discovery', () => {
  it('finds the nearest config above the test file (monorepo packages)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'bp-mono-'));
    const pkg = path.join(root, 'packages', 'web');
    mkdirSync(path.join(pkg, 'tests', 'repro'), { recursive: true });
    writeFileSync(path.join(root, 'playwright.config.ts'), '');
    expect(findConfig(path.join(pkg, 'tests', 'repro'))).toBe(path.join(root, 'playwright.config.ts'));
    writeFileSync(path.join(pkg, 'playwright.config.mjs'), '');
    expect(findConfig(path.join(pkg, 'tests', 'repro'))).toBe(path.join(pkg, 'playwright.config.mjs'));
  });

  it('resolves the runner CLI as a JS file (no .cmd shim needed on Windows)', () => {
    const cli = findRunnerCli(path.resolve(__dirname, '..'));
    expect(cli).toMatch(/cli\.js$/);
    expect(findRunnerCli(os.tmpdir())).toBeNull();
  });
});

describe('temp file cleanup', () => {
  it('sweepStale removes leftovers of dead processes only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bp-sweep-'));
    const dead = path.join(dir, '.bugprint-run-999999-1.config.ts');
    const alive = path.join(dir, `.bugprint-run-${process.pid}-1.config.ts`);
    const other = path.join(dir, 'playwright.config.ts');
    for (const f of [dead, alive, other]) writeFileSync(f, '');
    expect(sweepStale(dir, '.bugprint-run-')).toEqual(['.bugprint-run-999999-1.config.ts']);
    expect([existsSync(dead), existsSync(alive), existsSync(other)]).toEqual([false, true, true]);
  });

  it('tracked files are removed when the process is interrupted', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bp-sig-'));
    const file = path.join(dir, 'wrapper.config.ts');
    const script = `
      import { writeFileSync } from 'node:fs';
      import { trackPath } from ${JSON.stringify(path.resolve(__dirname, '../src/util/cleanup.ts'))};
      writeFileSync(${JSON.stringify(file)}, 'x');
      trackPath(${JSON.stringify(file)});
      console.log('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout!.on('data', (d) => String(d).includes('ready') && resolve()));
    expect(existsSync(file)).toBe(true);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(existsSync(file)).toBe(false);
  }, 20_000);
});
