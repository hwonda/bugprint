# bugprint

[English](README.md) · **한국어**

**사용자 세션 녹화를, 그 버그를 재현하며 실패하는 테스트로 바꿉니다.**

bugprint는 코딩 에이전트를 위한 MCP 서버입니다. 실제 사용자가 버그를 겪은 DOM 녹화([rrweb](https://github.com/rrweb-io/rrweb) 이벤트)를 넣으면, 사용자가 한 행동을 **사용자가 받았던 API 응답과 사용하던 시각 그대로** 다시 실행하는 E2E 테스트를 만듭니다. 그리고 그 테스트가 **녹화와 같은 방식으로 실패하는지** 확인합니다. 에이전트는 테스트가 통과할 때까지 코드를 고치고, 테스트는 회귀 테스트로 남습니다.

```
"재현이 안 돼요" 버그 리포트 ──▶ bugprint ──▶ 실패하는 e2e 테스트 ──▶ reproduced ──▶ 원인 단계만 남기기 ──▶ 에이전트가 수정 ──▶ passed
```

녹화를 테스트 스크립트로 바꾸는 일은 쉬운 편이고, 이미 하는 도구들이 있습니다. 어려운 건 **정말로 버그를 재현하는** 테스트입니다.

- **같은 환경:** 사용자가 받았던 API 응답을 그대로 돌려주고, 시계를 녹화 시점에 맞추고, 시작 시점의 저장소 상태를 복원합니다.
- **같은 실패:** 테스트를 실행해서, 녹화와 _같은_ 에러로 실패하는지 확인합니다. 바뀐 버튼을 못 찾아 시간 초과로 실패하는 건 재현으로 치지 않습니다.
- **필요한 것만:** 버그에 실제로 필요한 단계만 남도록 테스트를 줄입니다.

모든 로케이터는 녹화된 DOM에서 검증하고, 실제 test runner도 같은 요소를 가리키는지 테스트로 확인합니다.

---

## "재현이 안 되는" 버그를 재현하기

데모 쇼핑몰에는 데이터에 따라 생기는 버그가 있습니다. 버그가 보고된 날 쿠폰 API는 `{ "expired": true, "discount": null }`를 돌려줬는데, 클라이언트가 이 경우를 처리하지 않아서 결제에서 크래시가 났습니다. 개발자 PC에서는 쿠폰이 아직 유효해서, 같은 단계를 손으로 따라 해도 아무 문제가 없습니다.

```text
$ bugprint summarize fixtures/checkout-bug.json
Session ses_a0062914 · 00:04.4 · 13 steps · 3 page(s)
Pages: / → /?q=mouse → /checkout.html

[00:00.0] s1   open /
[00:00.4] s2   click button "Add to cart" in listitem "Mechanical Keyboard"
[00:01.0] s3   type "mouse" into field labelled "Search products"
[00:01.0] s4   press Enter in field labelled "Search products"
[00:01.0] s5   → navigated to /?q=mouse
[00:01.3] s6   click button "Add to cart"
[00:01.5] s7   click link "Go to checkout"
[00:01.5] s8   → navigated to /checkout.html
[00:02.5] s9   type "user@example.com" into field labelled "Email"
[00:03.0] s10  type "save20" into field labelled "Coupon code"
[00:03.4] s11  click button "Apply"
[00:03.8] s12  check field labelled "I agree to the terms"
[00:04.1] s13  click [data-testid="place-order"]
[00:04.1]   ⚠ uncaught-error: Uncaught (in promise) TypeError: Cannot read properties of null (reading 'rate')  @ HTMLFormElement.<anonymous> (http://localhost:4173/app.js:68:58)
```

생성된 테스트(일부 생략):

```ts
// @bugprint {"v":1,"session":"ses_a0062914","errors":["Uncaught (in promise) TypeError: Cannot read properties of null (reading 'rate')"]}
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env.BUGPRINT_BASE_URL ?? 'http://localhost:4173';

// API responses captured in the recording. They are served instead of the live backend,
// so the app sees exactly the data the user saw.
const RECORDED_RESPONSES: RecordedResponse[] = [
  {
    method: 'GET',
    url: '/api/coupons/save20',
    status: 200,
    contentType: 'application/json',
    body: '{"code":"SAVE20","expired":true,"discount":null}',
  },
];

test("repro: TypeError: Cannot read properties of null (reading 'rate')", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.clock.install({ time: new Date('2026-11-01T13:45:44.920Z') }); // when the session was recorded
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

같은 녹화로 `bugprint verify`를 돌린 결과:

|                                                 | 판정                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 버그 있는 앱 + 녹화된 응답                      | 🐞 `reproduced`: 녹화와 같은 `TypeError`로 실패                                          |
| 버그 있는 앱 + 실제 백엔드(`--no-mock-network`) | ✅ `passed`: **버그가 나타나지 않습니다.** 녹화된 응답을 재생해야 하는 이유가 이것입니다 |
| 수정한 앱 + 녹화된 응답                         | ✅ `passed`: 수정이 확인됨                                                               |

이어서 `bugprint minimize`가 13단계짜리 세션을 꼭 필요한 4단계로 줄입니다.

```text
$ bugprint minimize fixtures/checkout-bug.json --base-url http://localhost:4173
✂️ minimized — Reduced 13 steps to 4; the shorter test still fails with the recorded error.
   8 round(s), 26 test run(s), 17.8s

Kept:
  s8 · open /checkout.html
  s10 · type "save20" into field labelled "Coupon code"
  s11 · click button "Apply"
  s13 · click [data-testid="place-order"]
```

장바구니, 검색, 이메일 입력은 버그와 상관이 없습니다. 남은 단계가 쿠폰 응답과 주문 처리 코드를 바로 가리킵니다.

---

## 빠른 시작

### 1. MCP 서버 추가

**Claude Code**

```bash
claude mcp add bugprint -- npx -y bugprint
```

**Cursor / Claude Desktop / 그 밖의 MCP 클라이언트** (`mcp.json`)

```json
{
  "mcpServers": {
    "bugprint": { "command": "npx", "args": ["-y", "bugprint"] }
  }
}
```

### 2. 에이전트에게 요청

> `recordings/checkout.json`에 있는 버그를 http://localhost:3000 에서 재현하고 고쳐 줘.

서버에는 전체 흐름(load → summarize → generate → verify(`reproduced`) → minimize → 수정 → verify(`passed`))을 실행하는 `reproduce_bug` 프롬프트도 들어 있습니다.

### 3. CLI로 쓰기

```bash
npx bugprint summarize recording.json
npx bugprint generate recording.json -o tests/repro/checkout.spec.ts --base-url http://localhost:3000
npx bugprint verify tests/repro/checkout.spec.ts
npx bugprint minimize recording.json -o tests/repro/checkout.min.spec.ts --base-url http://localhost:3000
```

---

## 도구

| 도구                | 하는 일                                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_session`      | 파일 경로나 JSON(이벤트 배열, `{ events }`, NDJSON)에서 녹화를 불러옵니다. `sessionId`, 방문한 페이지, API 호출 수, 함께 쓴 녹화 플러그인, 잡힌 에러를 돌려줍니다.                                                                                                                                               |
| `summarize_session` | 단계마다 한 줄씩, 단계 id와 시각, 에러가 난 지점을 보여 줍니다. 원본 이벤트를 읽는 것보다 토큰이 훨씬 적게 듭니다.                                                                                                                                                                                               |
| `extract_flow`      | 단계별로 고른 로케이터와 그 신뢰도를 구조화된 데이터로 돌려줍니다. 에러, API 호출, 경고도 함께 줍니다.                                                                                                                                                                                                           |
| `generate_test`     | 재현 테스트를 씁니다. 범위를 줄이거나(`fromMs`/`toMs`, `includeSteps`/`excludeSteps`, 중간 페이지에서 시작하는 `startFrom`), 대상 주소를 바꾸거나(`baseUrl`), 로그인 상태 파일(`storageState`)을 넣을 수 있습니다. `mockNetwork`, `freezeTime`, `restoreStorage`, 비밀값 가리기(`keepSecrets`)는 끌 수 있습니다. |
| `run_and_verify`    | **프로젝트의 테스트 설정 그대로**(테스트 파일 위쪽의 가장 가까운 설정, 또는 `config`) 테스트를 실행하고 판정을 돌려줍니다. 예상과 다른 곳에서 실패하면 실패한 단계도 알려줍니다. `expect`를 주면 `ok: true/false`를 더합니다(CLI에서는 종료 코드).                                                               |
| `minimize_repro`    | 여전히 `reproduced`인 가장 짧은 테스트를 찾습니다. 먼저 중간 페이지를 바로 열어 보고, 그다음 delta debugging으로 단계를 지웁니다. 라운드마다 후보를 한 번에 병렬로 실행하고, 진행 상황은 MCP progress 알림으로 보냅니다. `confirmRuns`를 주면 결과를 여러 번 다시 돌려 간헐적인 버그를 걸러냅니다.               |
| `list_sessions`     | 이 서버 프로세스에 불러온 세션 목록입니다.                                                                                                                                                                                                                                                                       |

### 판정

| 판정                 | 뜻                                                           | 에이전트가 다음에 할 일                                      |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `reproduced`         | 녹화와 같은 에러로 실패                                      | 앱 코드를 고친다                                             |
| `failed-differently` | 다른 곳에서 실패(예: `failedStep: s11 click button "Apply"`) | 앱이 아니라 테스트부터 조정한다(단계 줄이기, `baseUrl` 확인) |
| `passed`             | 녹화된 에러가 나지 않음                                      | 수정 전이면 재현 실패, 수정 후면 수정 완료                   |
| `failed`             | 실패했지만 녹화에 비교할 에러가 없음                         | 실패 내용을 직접 확인한다                                    |
| `error`              | runner를 실행하지 못함(의존성 누락, 설정 오류 등)            | 환경 설정을 고친다                                           |

---

## 세션 녹화하기

bugprint는 표준 rrweb 이벤트를 읽습니다. 플러그인을 더할수록 재현이 정확해집니다.

```ts
import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { getRecordNetworkPlugin } from '@rrweb/rrweb-plugin-network-record';
import { getRecordBugprintPlugin } from 'bugprint/recorder';

record({
  emit: (e) => events.push(e),
  plugins: [
    getRecordConsolePlugin({ level: ['error', 'warn'] }), // errors → the assertion
    getRecordNetworkPlugin({ recordBody: true }), // API responses → replayed in the test
    getRecordBugprintPlugin(), // initial storage, keys, SPA routes, back/forward
  ],
});
```

| 플러그인                     | 없으면                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| console                      | 확인할 에러가 없습니다. 단계는 재생하지만 확인 코드(assertion)는 직접 써야 합니다.        |
| network (`recordBody: true`) | 실제 백엔드를 호출하므로, API 데이터에 따라 생기는 버그는 재현되지 않을 수 있습니다.      |
| `bugprint/recorder`          | 시작 시점의 localStorage와 쿠키, Enter로 제출, 단축키, 클라이언트 라우트 변경이 빠집니다. |

`bugprint/recorder`는 의존성이 없고 크기는 약 6KB입니다. 녹화를 시작할 때 localStorage와 읽을 수 있는 쿠키를 저장합니다. 민감한 키(`accessToken`, `sessionId`, `apiKey`, `password`, `csrf` 등)는 이름만 남기고, 값은 브라우저 밖으로 내보내지 않습니다. 키는 단어 단위로 판단하므로 `author`가 `auth`로 걸리지 않습니다. 직접 추가하려면 `sensitiveKeys`를 쓰세요.

일반 타이핑은 녹화하지 않고, 특수 키와 Ctrl/Meta/Alt 단축키만 녹화합니다. 입력 필드의 값은 rrweb이 이미 녹화하고, rrweb 자체의 마스킹도 적용됩니다.

---

## 동작 방식

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
Code generation ─ clock set to the recording time, starting storage restored, recorded
   │              responses served in order (large ones in a sidecar file), BASE_URL
   │              indirection, PII redaction, masked passwords → env vars
   ▼
Verification ─── runs tests through a temporary wrapper around your config, reads the
   │             JSON report, matches the page errors the test actually observed
   │             against the recorded error, and maps the failing line to its step id
   ▼
Minimization ─── latest page that can be opened directly, then ddmin over the rest;
                 every round is one batched, parallel run
```

설계 결정:

- **로케이터는 녹화된 DOM에서 검증합니다.** test runner가 쓰는 ARIA 역할과 accessible name 규칙의 일부를 다시 구현했습니다. 녹화 당시 DOM에서 요소를 정확히 하나만 가리키는 로케이터만 씁니다.
- **실패하기만 하면 되는 게 아니라, 같은 이유로 실패해야 합니다.** 바뀐 버튼을 못 찾아 시간 초과로 실패하는 테스트는 재현이 아닙니다. `run_and_verify`는 실패 내용을 녹화된 에러와 비교합니다. 그래서 에이전트가 깨진 로케이터 때문에 멀쩡한 앱 코드를 "고치는" 일을 막습니다.
- **클릭뿐 아니라 환경도 재생합니다.** "재현이 안 되는" 버그는 대개 데이터나 시간에 따라 생깁니다. 녹화된 응답을 도착한 순서대로 돌려주고, 브라우저 시계를 녹화 시점부터 시작합니다.
- **에러는 페이지가 실제로 던진 것끼리 비교합니다.** 테스트가 잡은 에러를 annotation으로 넘기고, verify는 그것만 녹화된 에러와 비교합니다. 실패 메시지 원문과는 비교하지 않습니다. 초기 버전은 원문과 비교했는데, minimize가 이 문제를 잡아냈습니다. 실패 메시지에는 코드 일부가 같이 찍히는데, 그 코드의 주석이 녹화된 에러를 인용하고 있어서 상관없는 404 에러까지 재현으로 판정됐습니다. 지금은 회귀 테스트로 막혀 있습니다.
- **축소는 묶어서 실행합니다.** delta debugging은 테스트를 여러 번 실행해야 합니다. 라운드마다 후보를 모두 별도 파일로 쓰고, 한 번의 실행에서 병렬로 돌립니다. 그래서 앱 서버는 후보마다가 아니라 라운드마다 한 번만 뜹니다.
- **출력은 에이전트에 맞춘 크기입니다.** `summarize_session`은 짧은 타임라인만 돌려줍니다. 에이전트는 단계 id로 녹화를 다시 읽지 않고 테스트를 줄일 수 있고, `failedStep`은 깨진 줄을 정확히 가리킵니다.
- **개인정보와 비밀값이 먼저입니다.** 생성된 테스트는 보통 git에 커밋되기 때문입니다.
  - 입력한 이메일, 전화번호, 카드번호는 형태가 같은 가짜 값으로 바꿉니다.
  - 응답과 저장소에서 토큰(JWT, Bearer, 흔한 API 키 형식)과 민감한 키의 값을 가립니다. id와 숫자는 그대로 둬서 이후 요청이 계속 맞아떨어집니다.
  - 마스킹된 비밀번호는 `process.env.BUGPRINT_SECRET_n`이 됩니다.
- **실제 runner와 실제 에이전트로 검증했습니다.** [docs/validation.md](docs/validation.md)를 보세요. 생성한 로케이터를 실제 test runner로 풀어 보는 테스트가 있고, 노드 2만 개짜리 페이지에서 클릭당 약 54ms가 걸리며, runner 최소 버전도 확인했습니다. 헤드리스 코딩 에이전트가 이 도구만으로 데모 버그를 17턴 만에 혼자 고쳤습니다. 각 검증에서 실제 버그를 찾아 고쳤습니다.

---

## 데모

```bash
npm install
npx playwright install chromium
npm run demo         # generate + verify  → 🐞 reproduced
npm run demo:live    # 같은 단계를 실제 API로 → ✅ passed (버그가 나타나지 않음)
npm run demo:fixed   # 녹화된 응답 + 수정한 앱 → ✅ passed (수정 확인)
npm run demo:minimize  # 13단계 → 4단계
```

데모 쇼핑몰을 직접 녹화하려면 `npm run build && npm run demo:serve`를 실행하고 http://localhost:4173 을 여세요. 콘솔에서 `__bugprintDownload()`를 호출하면 녹화가 저장됩니다. `npm run demo:record`는 API를 "쿠폰 만료" 모드로 두고, 스크립트로 움직이는 사용자로 fixture를 다시 녹화합니다.

---

## 호환성

- Node.js 20 이상
- 프로젝트에 `@playwright/test` 1.45 이상. 생성된 테스트가 1.45에서 추가된 `page.clock`을 씁니다. 오래된 runner는 새 Node에서 멈출 수 있습니다(1.45 + Node 24가 그렇습니다). 그런 경우로 보이면 `verify`가 알려 줍니다.
- CI는 Linux, macOS, Windows에서 Node 20과 24로 돌아갑니다.

---

## 한계와 로드맵

- 민감한 저장소 값(인증 토큰, 세션 쿠키)과 HttpOnly 쿠키는 녹화하지 않습니다. 로그인한 사용자가 필요한 버그라면 `storageState` 파일을 직접 넣으세요.
- 메인 프레임만 다룹니다. iframe과 여러 탭은 지원하지 않습니다.
- WebSocket과 server-sent events는 재생하지 않습니다.
- 외부 세션 녹화 서비스의 export 형식은 범용 방식으로만 인식합니다. 어떤 깊이에 있든 rrweb 이벤트를 찾고 세그먼트를 합칩니다. 특정 서비스의 실제 export 파일로는 아직 검증하지 않았습니다.
- 축소는 버그가 매번 똑같이 재현된다고 가정합니다. 녹화된 응답과 고정된 시계 덕분에 보통은 그렇습니다. `--confirm <n>`으로 확인할 수 있습니다.

다음(v1.0): npm 배포, MCP Registry 등록, 데모 영상, 실제 오픈소스 앱 적용 사례.

---

## 개발

```bash
npm run check       # 린트(oxlint) + 포맷(Prettier) + 타입 + 전체 테스트
npm test            # 단위, MCP 통합, 실제 브라우저 테스트(vitest)
npm run bench       # 대형 페이지 벤치마크
npm run build
npm run inspect     # dist/로 MCP Inspector 열기
```

계정이 필요한 배포 단계는 [docs/release-checklist.md](docs/release-checklist.md)에 정리돼 있습니다. 변경 내역은 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

## 라이선스

MIT
