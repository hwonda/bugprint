# Changelog

## Unreleased

### Added

- Secrets are redacted from recorded API responses, storage and typed values: tokens, API keys, and values under keys such as `accessToken` or `sessionId`. Keys are matched by their words, so `author` is not caught by `auth`. Use `keepSecrets` to opt out.
- `storageState` option: supply a logged-in state file; the recorded localStorage is layered on top.
- `minimize --confirm <n>` / `confirmRuns`: rerun the minimal test n times and accept it only if every run reproduces, otherwise the verdict is `flaky`.
- `verify --expect <verdict>` with CI exit codes (0 ok, 1 different verdict, 2 runner error).
- The nearest runner config above the test file is used, which supports monorepos. `--config` overrides it.
- `npm run bench`: a large-page benchmark. `docs/validation.md` records the validation results.
- Lint (oxlint) and formatting (Prettier). CI on Linux, macOS and Windows with Node 20 and 24.

### Fixed

- Values a framework sets in code (for example React re-rendering a list row) were recorded as user input and became fake steps: 13 of 33 steps in a real TodoMVC session. Input is now accepted only on the focused element (label clicks count). rrweb's `userTriggered` flag is used when present, and the recorder reports the element that had focus when recording started.
- Controls that only appear on row hover (delete buttons) could not be clicked on replay. A control scoped to a row now hovers the row first.
- Recorded responses and storage values were re-serialised, which changed 64-bit ids, `1.50` and `1e3`. Only the redacted strings are rewritten now; everything else stays byte-identical.
- Mocked cross-origin responses lacked CORS headers, and their preflight requests went to the network.
- A crash that made a later step fail first was judged `failed-differently`. The errors a test observes are now reported live.
- The `verify` wrapper broke configs whose project depends on a setup project, and `.cjs` configs.
- One malformed cookie name aborted the whole recording.
- Smaller fixes: an empty recorded error matched everything; a Back press to a page from before the recording was not replayed; network entries without a status were reported as failures; segments keyed by id were dropped; `cookieConsent` was treated as a secret; console plugins under other names were ignored; response keys kept the `#fragment`; minimize checked candidates with a different response-size limit than the test it wrote; a failed progress notification could crash the server.
- Accessible names computed from content now separate block and cell text ("Alice Edit", not "AliceEdit"), matching the test runner.
- Containers whose text is a substring of another's ("Product 1" / "Product 10") are now scoped by an exact heading instead of falling back to `.nth()`.
- When `expectVisibleText` is used, the recorded-error check now runs first, so a crash is no longer hidden behind a timeout.
- The test runner is started as `node <cli.js>`, without `.cmd` shims, so verify works on Windows.
- Temporary configs and minimize folders are removed when bugprint is interrupted, and leftovers from killed processes are cleaned up on the next run.
- `verify` explains the case where the runner hangs without printing anything (old runner on a newer Node).

## 0.3.0

### Added

- `minimize_repro` / `bugprint minimize`: finds the shortest test that is still `reproduced`. It first tries opening later pages directly, then runs delta debugging over the remaining steps. Each round runs in one batched, parallel invocation, and progress is reported through MCP notifications.
- Initial storage (localStorage and readable cookies) is captured by `bugprint/recorder` and restored with `storageState`. Sensitive keys never leave the browser.
- `startFrom`: start a test at a later page.
- Large recorded responses are written to a `<name>.responses.json` sidecar file.
- Recordings exported in nested or segmented JSON are detected.

### Fixed

- A false `reproduced` verdict. The failure message's code frame quoted the recorded error from a comment, so an unrelated error counted as a match. Tests now report the errors they observed through an annotation, and only those are compared.
- The browser's automatic "Failed to load resource" logs no longer count as page errors.

## 0.2.0

### Added

- `run_and_verify` / `bugprint verify`, with the verdicts `reproduced`, `failed-differently`, `passed`, `failed` and `error`, and the failing step mapped back from the failing line.
- Recorded API responses (`rrweb/network@1`) are served in the generated test.
- The browser clock is set to the recording time.
- `bugprint/recorder`: an rrweb plugin that records keys (Enter, Escape, shortcuts), SPA routes, and back/forward navigation.

## 0.1.0

- First version: rrweb recording → virtual DOM → normalized steps → semantic locators checked against the recorded DOM → reproduction test. Includes the MCP server and the CLI.
