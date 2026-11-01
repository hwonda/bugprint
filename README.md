# bugprint

**Turn a recorded user session into a failing test that reproduces the bug.**

bugprint is an MCP server for coding agents. You give it a DOM recording of a real user hitting a bug ([rrweb](https://github.com/rrweb-io/rrweb) events). It returns an end-to-end test that replays what the user did, **with the API responses the user got and at the time they used the app**, and checks that the test **fails the same way**. The agent fixes the code until the test passes, and the test stays as a regression test.

```
"Can't reproduce" bug report ──▶ bugprint ──▶ failing e2e test ──▶ verdict: reproduced ──▶ agent fixes ──▶ verdict: passed
```

Most session tools stop at *showing* you the recording, and video-based tools have to *guess* what happened from pixels. bugprint works from the recorded DOM and network data, so every step resolves to a real element and every response is the one the user actually saw.

---

## The "can't reproduce" bug, reproduced

The demo shop has a bug that depends on data. On the day of the report, the coupon API answered `{ "expired": true, "discount": null }`, the client didn't check for it, and checkout crashed. On a developer machine the coupon is still valid, so clicking through the same steps by hand works fine.

```text
$ bugprint summarize fixtures/checkout-bug.json
Session ses_300a5a4b · 00:04.2 · 13 steps · 3 page(s)
Pages: / → /?q=mouse → /checkout.html

[00:00.0] s1   open /
[00:00.3] s2   click button "Add to cart" in listitem "Mechanical Keyboard"
[00:00.8] s3   type "mouse" into field labelled "Search products"
[00:00.9] s4   press Enter in field labelled "Search products"
[00:00.9] s5   → navigated to /?q=mouse
[00:01.1] s6   click button "Add to cart"
[00:01.4] s7   click link "Go to checkout"
[00:01.4] s8   → navigated to /checkout.html
[00:02.3] s9   type "user@example.com" into field labelled "Email"
[00:02.8] s10  type "save20" into field labelled "Coupon code"
[00:03.2] s11  click button "Apply"
[00:03.6] s12  check field labelled "I agree to the terms"
[00:03.8] s13  click [data-testid="place-order"]
[00:03.8]   ⚠ uncaught-error: Uncaught (in promise) TypeError: Cannot read properties of null (reading 'rate')  @ HTMLFormElement.<anonymous> (http://localhost:4173/app.js:68:58)
```

The generated test (abridged):

```ts
// @bugprint {"v":1,"session":"ses_300a5a4b","errors":["Uncaught (in promise) TypeError: Cannot read properties of null (reading 'rate')"]}
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env.BUGPRINT_BASE_URL ?? 'http://localhost:4173';

// API responses captured in the recording. They are served instead of the live backend,
// so the app sees exactly the data the user saw.
const RECORDED_RESPONSES: RecordedResponse[] = [
  {"method":"GET","url":"/api/coupons/save20","status":200,"contentType":"application/json","body":"{\"code\":\"SAVE20\",\"expired\":true,\"discount\":null}"},
];

test('repro: TypeError: Cannot read properties of null (reading \'rate\')', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.clock.install({ time: new Date('2026-11-01T13:13:45.390Z') }); // when the session was recorded
  await serveRecordedResponses(page, RECORDED_RESPONSES);

  await page.goto(BASE_URL + '/');
  await page.getByRole('listitem').filter({ hasText: 'Mechanical Keyboard' }).getByRole('button', { name: 'Add to cart' }).click();
  await page.getByLabel('Search products').fill('mouse');
  await page.getByLabel('Search products').press('Enter');
  await expect(page).toHaveURL(BASE_URL + '/?q=mouse');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('link', { name: 'Go to checkout' }).click();
  await expect(page).toHaveURL(BASE_URL + '/checkout.html');
  await page.getByLabel('Email').fill('user@example.com'); // redacted
  await page.getByLabel('Coupon code').fill('save20');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByLabel('I agree to the terms').check();
  await page.getByTestId('place-order').click();

  await page.waitForTimeout(300);
  expect(errors, 'the page should not throw while replaying the recorded steps').toEqual([]);
});
```

Results from `bugprint verify` on the same recording:

| | Verdict |
|---|---|
| Buggy app, recorded responses | 🐞 `reproduced`: fails with the recorded `TypeError` |
| Buggy app, live backend (`--no-mock-network`) | ✅ `passed`: **the bug does not show up**, which is why replaying the recorded responses matters |
| Fixed app, recorded responses | ✅ `passed`: the fix is confirmed |

---

## Quick start

### 1. Add the MCP server

**Claude Code**

```bash
claude mcp add bugprint -- npx -y bugprint
```

**Cursor / Claude Desktop / any MCP client** (`mcp.json`)

```json
{
  "mcpServers": {
    "bugprint": { "command": "npx", "args": ["-y", "bugprint"] }
  }
}
```

### 2. Ask your agent

> Reproduce the bug in `recordings/checkout.json` against http://localhost:3000, then fix it.

The server also ships a `reproduce_bug` prompt that runs the whole loop: load → summarize → generate → verify (`reproduced`) → fix → verify (`passed`).

### 3. Or use the CLI

```bash
npx bugprint summarize recording.json
npx bugprint generate recording.json -o tests/repro/checkout.spec.ts --base-url http://localhost:3000
npx bugprint verify tests/repro/checkout.spec.ts
```

---

## Tools

| Tool | What it does |
|---|---|
| `load_session` | Load a recording from a path or inline JSON (event array, `{ events }` or NDJSON). Returns a `sessionId`, the pages visited, the API call count, which recorder plugins were present, and any captured errors. |
| `summarize_session` | One line per step, with step ids, timestamps and where errors happened. Far cheaper in tokens than raw events. |
| `extract_flow` | Structured steps with the chosen locator and a confidence score for each, plus errors, API calls and warnings. |
| `generate_test` | Writes the reproduction test. You can trim it (`fromMs`/`toMs`, `includeSteps`/`excludeSteps`), retarget it (`baseUrl`), and switch off `mockNetwork` or `freezeTime`. |
| `run_and_verify` | Runs the test with **your project's own test config** (webServer, baseURL and so on) and returns a verdict, plus the failing step when the test broke somewhere unexpected. |
| `list_sessions` | Sessions loaded in this server process. |

### Verdicts

| Verdict | Meaning | What the agent does next |
|---|---|---|
| `reproduced` | Fails with the error recorded in the session | Fix the app code |
| `failed-differently` | Fails at another point, e.g. `failedStep: s11 click button "Apply"` | Adjust the test first (trim steps, check `baseUrl`), not the app |
| `passed` | The recorded error did not happen | Before a fix: not reproduced. After a fix: fixed |
| `failed` | Fails, but the recording had no error to compare with | Check the failure by hand |
| `error` | The runner could not run (missing dependency, config error) | Fix the setup |

---

## Recording sessions

bugprint reads standard rrweb events. Each plugin you add makes the reproduction more faithful:

```ts
import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { getRecordNetworkPlugin } from '@rrweb/rrweb-plugin-network-record';
import { getRecordBugprintPlugin } from 'bugprint/recorder';

record({
  emit: (e) => events.push(e),
  plugins: [
    getRecordConsolePlugin({ level: ['error', 'warn'] }), // errors → the assertion
    getRecordNetworkPlugin({ recordBody: true }),          // API responses → replayed in the test
    getRecordBugprintPlugin(),                             // Enter/Escape/shortcuts, SPA routes, back/forward
  ],
});
```

| Plugin | Without it |
|---|---|
| console | No error to assert on. The test replays the steps, but you have to write the assertion yourself. |
| network (`recordBody: true`) | The test hits your live backend, so bugs that depend on API data may not reproduce. |
| `bugprint/recorder` | Enter-to-submit, keyboard shortcuts and client-side route changes are missing. |

`bugprint/recorder` has no dependencies, weighs about 4 KB, and never records ordinary typing (only special keys and Ctrl/Meta/Alt shortcuts). rrweb already records field values and applies its own masking to them.

---

## How it works

```
rrweb events
   │
   ▼
Virtual DOM ─── replays the full snapshot and every mutation, so "node #57" resolves
   │            to what the element looked like at the moment it was clicked
   ▼
Flow extraction ─ collapses keystrokes into one fill, drops focus/label clicks and the
   │              synthetic click an Enter press causes, tells navigations apart from
   │              re-snapshots, follows pushState/back/forward, attaches console errors
   │              to the step that caused them, and collects fetch/XHR responses
   ▼
Locator builder ─ testid → label → role+name → placeholder → text → id → CSS path.
   │              Every candidate is checked for uniqueness against the recorded DOM.
   │              Duplicates are scoped to a container before falling back to .nth()
   ▼
Code generation ─ clock set to the recording time, recorded responses served in order,
   │              BASE_URL indirection, PII redaction, masked passwords → env vars
   ▼
Verification ─── runs the test through a temporary wrapper around your config, reads
                 the JSON report, matches the failure against the recorded error, and
                 maps the failing line back to its step id
```

Design decisions:

- **Locators are checked against the recording.** bugprint reimplements a subset of the ARIA role and accessible-name rules the test runner uses. A locator only counts if it matches exactly one element in the DOM as it was recorded.
- **"It fails" isn't enough; it has to fail the right way.** A test that times out on a changed button is not a reproduction. `run_and_verify` compares the failure with the recorded error, so the agent doesn't start "fixing" the app because of a broken locator.
- **The environment is replayed along with the clicks.** Data-dependent and time-dependent bugs are the ones that "can't be reproduced". Recorded responses are served in the order they arrived, and the browser clock starts at the recording time.
- **Output is sized for agents.** `summarize_session` returns a short timeline. Step ids let the agent cut a test down without re-reading the recording, and `failedStep` points at the exact line that broke.
- **Privacy comes first.** Typed e-mails, phone numbers and card numbers are swapped for fakes of the same shape. In recorded responses only e-mail addresses inside string values are replaced, so ids that later requests depend on stay intact. Masked passwords become `process.env.BUGPRINT_SECRET_n`.

---

## Demo

```bash
npm install
npx playwright install chromium
npm run demo         # generate + verify  → 🐞 reproduced
npm run demo:live    # same steps against the live API → ✅ passed (the bug doesn't show up)
npm run demo:fixed   # recorded responses + patched app → ✅ passed (fix confirmed)
```

To record your own session of the demo shop, run `npm run build && npm run demo:serve` and open http://localhost:4173. Call `__bugprintDownload()` in the console to save the recording. `npm run demo:record` re-records the fixture with a scripted user, with the API in "coupon expired" mode.

---

## Limitations and roadmap

- Browser state the session started with (cookies, localStorage, login) is not restored yet.
- Recorded responses are inlined in the test file. Very large responses (> 256 KB) are skipped and go to the live backend.
- WebSocket and server-sent event traffic is not replayed.

Next:

- [ ] `minimize_repro`: delta debugging to find the smallest set of steps that still gives `reproduced`
- [ ] Restore initial storage state (localStorage, cookies) from the recording
- [ ] Adapters for hosted session-recording services
- [ ] Store large response fixtures in a separate file

---

## Development

```bash
npm test            # unit, MCP integration and real-browser verify tests (vitest)
npm run typecheck
npm run build
npm run inspect     # open the MCP Inspector against dist/
```

## License

MIT
