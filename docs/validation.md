# Validation

How bugprint was checked beyond unit tests. All numbers are from 2026-11-02 on an Apple Silicon Mac (macOS, Darwin 27).

## 1. Generated locators agree with the real test runner

`test/locator-agreement.e2e.test.ts` records tricky pages with rrweb in Chromium, lets bugprint choose a locator for every clicked element, and asks the real test runner which elements that locator matches. It must be exactly one element: the one that was clicked.

Cases: headings that are substrings of each other ("Product 1" / "Product 10"), `Save` vs `Save draft`, `for=` and wrapping labels, placeholders, hidden duplicates, `aria-label` / `aria-labelledby`, quotes, table rows, and non-semantic clickable `<div>`s.

What it found:

| Found                                                                                                                         | Fix                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Accessible names of rows/cells were computed as `AliceEdit`; browsers say `Alice Edit` (block and cell boundaries add spaces) | Separate "name from content" from `textContent`, inserting spaces at block and cell boundaries |
| `filter({ hasText: 'Product 1' })` also matches `Product 10`, which made bugprint fall back to `.nth()`                       | Exact container scoping: `filter({ has: getByRole('heading', { name, exact: true }) })`        |

## 2. Large pages

`npm run bench`: product cards whose buttons all share the same name, which forces container scoping on every click. Each run has 20 clicks.

| Cards | DOM nodes |   Time | Per click | Wrong targets | Positional (`.nth`) |
| ----: | --------: | -----: | --------: | ------------: | ------------------: |
|   100 |     1,007 |  66 ms |    3.3 ms |             0 |                   0 |
|   600 |     6,007 | 320 ms |     16 ms |             0 |                   0 |
| 2,000 |    20,007 |  1.1 s |     54 ms |             0 |                   0 |

The cost grows roughly linearly with page size.

## 3. Compatibility

| Node  | @playwright/test               | Result                                                                                                                                                              |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24.21 | 1.64.1                         | full test suite (65) ✅                                                                                                                                             |
| 20.20 | 1.64.1                         | full test suite (65) ✅                                                                                                                                             |
| 20.20 | 1.45.0 (minimum: `page.clock`) | demo: verify `reproduced` / fixed `passed`, minimize 13 → 4 ✅                                                                                                      |
| 24.21 | 1.45.0                         | ❌ the runner hangs before loading its config. This is a problem in the old runner, not in bugprint. `verify` now explains this case when the runner prints nothing |

Windows is not tested locally. The runner is started as `node <cli.js>` (no `.cmd` shim, no shell), and CI covers Windows.

## 4. A real agent, end to end

Headless Claude Code (`claude -p`) in a copy of the demo project. Only the bugprint tools plus Read, Edit, Glob and Grep were allowed. The prompt said only that checkout crashes and that `recording.json` holds the user's session.

```
load_session → summarize_session → generate_test (with expectVisibleText "Order placed!")
→ run_and_verify: failed-differently
→ agent reorders the test's assertions → run_and_verify: reproduced
→ fixes demo/app/app.js (treat expired coupons as invalid, guard discount)
→ run_and_verify (expect: passed): passed
```

The run took 17 turns, 67 s, and cost $0.40. The fix was correct.

It also found a bugprint bug: the "expected text is visible" assertion came _before_ the error check, so a crash surfaced as a timeout (`failed-differently`). Assertions are now ordered the other way round, and a test covers it.
