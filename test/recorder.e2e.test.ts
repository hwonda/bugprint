// Runs the bugprint recorder plugin inside a real browser.
import path from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;

beforeAll(async () => {
  const { startServer } = await import(path.join(root, 'demo/serve.mjs'));
  server = await startServer(4174);
});
afterAll(() => server?.close());

describe('bugprint/recorder in a browser', () => {
  it('captures storage (minus secrets), special keys, pushState and back', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      if (location.pathname !== '/') return;
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('authToken', 'eyJ-secret');
      document.cookie = 'lang=ko';
      document.cookie = 'session_id=abc';
    });
    await page.goto('http://localhost:4174/');
    await page.getByRole('searchbox', { name: 'Search products' }).fill('mouse');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/?q=mouse');
    await page.keyboard.press('Control+k');
    await page.goBack();
    await page.waitForURL('http://localhost:4174/');
    await page.waitForTimeout(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = await page.evaluate(() => (window as any).__bugprintEvents);
    await browser.close();

    const payloads = events.filter((e) => e.type === 6 && e.data.plugin === 'bugprint/interaction@1').map((e) => e.data.payload);
    const storage = payloads.find((p) => p.type === 'storage');
    expect(storage.localStorage).toEqual({ theme: 'dark' });
    expect(storage.cookies).toEqual({ lang: 'ko' });
    expect(storage.masked.sort()).toEqual(['authToken', 'session_id']);
    expect(JSON.stringify(events)).not.toContain('eyJ-secret');

    expect(payloads.filter((p) => p.type === 'key').map((p) => p.key)).toEqual(['Enter', 'Control+k']);
    expect(payloads.find((p) => p.type === 'key' && p.key === 'Enter').id).toBeGreaterThan(0);
    expect(payloads.filter((p) => p.type === 'nav').map((p) => `${p.via} ${new URL(p.href).search}`)).toEqual(['push ?q=mouse', 'back ']);
  }, 60_000);
});
