// Drives the demo shop like a real user (with rrweb recording on) and saves
// the session to fixtures/checkout-bug.json.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { startServer } from './serve.mjs';

const server = await startServer(4173);
const browser = await chromium.launch();
const page = await browser.newPage();
const human = () => page.waitForTimeout(150 + Math.random() * 200);

await page.goto('http://localhost:4173/');
await human();
await page.mouse.wheel(0, 200);
await human();
await page.getByRole('button', { name: 'Add to cart' }).first().click();
await human();
await page.getByRole('button', { name: 'Add to cart' }).nth(1).click();
await human();
await page.getByRole('link', { name: 'Go to checkout' }).click();
await page.waitForURL('**/checkout.html');
await human();
await page.getByLabel('Email').click();
await page.keyboard.type('jane.doe@example.com', { delay: 40 });
await human();
await page.getByLabel('Coupon code').click();
await page.keyboard.type('sav', { delay: 60 });
await page.keyboard.press('Backspace');
await page.keyboard.type('ve20', { delay: 60 });
await human();
await page.getByRole('button', { name: 'Apply' }).click();
await human();
await page.getByLabel('I agree to the terms').check();
await human();
await page.getByTestId('place-order').click();
await page.waitForTimeout(500);

const events = await page.evaluate(() => window.__bugprintEvents);
fs.writeFileSync(new URL('../fixtures/checkout-bug.json', import.meta.url), JSON.stringify(events, null, 0));
console.log(`saved ${events.length} events`);
await browser.close();
server.close();
