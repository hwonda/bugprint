// Drives the demo shop like a real user (with rrweb recording on) and saves the
// session to fixtures/checkout-bug.json. The API is put in "coupon expired" mode,
// which is what production answered when the bug was reported.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

process.env.DEMO_COUPON_EXPIRED = '1';
const { startServer } = await import('./serve.mjs');
const server = await startServer(4173);
const browser = await chromium.launch();
const page = await browser.newPage();
const human = () => page.waitForTimeout(150 + Math.random() * 200);

await page.goto('http://localhost:4173/');
await human();
await page.getByRole('button', { name: 'Add to cart' }).first().click();
await human();
await page.getByRole('searchbox', { name: 'Search products' }).click();
await page.keyboard.type('mouse', { delay: 50 });
await page.keyboard.press('Enter');
await page.waitForURL('**/?q=mouse');
await human();
await page.getByRole('button', { name: 'Add to cart' }).click(); // only the mouse is visible now
await human();
await page.getByRole('link', { name: 'Go to checkout' }).click();
await page.waitForURL('**/checkout.html');
await human();
await page.getByLabel('Email').click();
await page.keyboard.type('jane.doe@example.com', { delay: 30 });
await human();
await page.getByLabel('Coupon code').click();
await page.keyboard.type('save20', { delay: 50 });
await human();
await page.getByRole('button', { name: 'Apply' }).click();
await page.getByText('Coupon SAVE20 applied').waitFor();
await human();
await page.getByLabel('I agree to the terms').check();
await human();
await page.getByTestId('place-order').click();
await page.waitForTimeout(500);

const events = await page.evaluate(() => window.__bugprintEvents);
fs.writeFileSync(new URL('../fixtures/checkout-bug.json', import.meta.url), JSON.stringify(events));
console.log(`saved ${events.length} events`);
await browser.close();
server.close();
