# 보호자 계정 · 탭 3개 · 기억 꺼내기 · 예상 후보지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보호자 여러 명이 이메일 계정으로 같은 어르신의 추억의 장소·일지·기록·실시간 위치를 함께 쓰고, 탭 3개(📍 실시간 위치 · 🚨 실종자 찾기 · 📝 추억의 장소) 안에서 기존 기능 + 기억 꺼내기 대화 + GPS 예상 경로 후보지를 쓴다.

**Architecture:** 로그인은 브라우저가 Supabase Auth REST를 직접 부르고, 데이터는 기존 `api/loc.js`에 action을 더해 서버가 토큰을 확인한 뒤 service_role로 Supabase 표를 읽고 쓴다(업무 로직은 `lib/family.js`). 브라우저는 기존 `store`(localStorage)를 "현재 어르신의 사본"으로 쓰고 `public/js/family.js`가 서버와 동기화한다 — 기존 화면 코드는 거의 그대로. 예상 경로·후보 계산은 순수 함수 `public/lib/predict.js`, AI는 `api/diary.js`의 새 mode 두 개(`memory`, `candidates`).

**Tech Stack:** 순수 HTML/CSS/JS ES 모듈(빌드 없음) · Vercel 서버리스(Node 20+, ESM) · Supabase Auth + PostgREST(`fetch`) · Upstage/Gemini/Claude(`lib/claude.js`) · 테스트 `node --test`(내장, 패키지 없음) · Android Kotlin(어르신 앱, GitHub Actions 빌드)

**Spec:** `docs/superpowers/specs/2026-11-17-guardian-accounts-design.md`

## Global Constraints

- npm 패키지 추가 금지, 빌드 단계 없음. 브라우저 외부 스크립트는 지금처럼 CDN만(QR 표시: cdnjs `qrcode-generator@1.4.4`).
- Vercel 함수 12개 — `api/`에 새 파일 금지. 공용 로직은 `lib/`(함수 아님)에.
- 서버에 남는 사람 정보는 이메일(Supabase Auth)뿐. 이름·전화번호 안 받음. 어르신은 호칭만.
- 집 주소·집 좌표는 서버로 보내지 않는다(어르신별 기기 저장). 보호자가 말한 원문 전체(`utterance`)는 서버로 보내지 않는다.
- 로그인 화면 맨 위 고정 문구: "치매 어르신은 즉시 신고 대상입니다. 먼저 112에 전화하세요." + 빨간 112 버튼.
- 실종자 찾기는 로그인 필요. 서버 장애 시 이 폰의 마지막 사본으로 동작.
- 로그아웃은 서버 데이터를 지우지 않는다. 다른 계정으로 로그인할 때만 이 폰의 이전 계정 사본 삭제.
- 자동 삭제는 `loc_events` 30일뿐. 어르신 데이터는 owner의 삭제 또는 마지막 member 이탈 때만 삭제.
- 초대 토큰: 24시간, 1회. 역할 `owner` | `member`; 초대는 member 누구나, 내보내기·어르신 삭제·연결 코드 재발급은 owner만.
- 예상 후보지: 계산은 코드, AI는 후보 목록 안에서만 순서·이유. 목록 밖 id는 버리고, 이유의 숫자가 계산값에 없으면 ⚠. AI 실패 시 코드 순서.
- 화면: 본문 18px 이상, 터치 48px 이상, 존댓말, "어르신", MOCK_AI 배너 유지. 마지막 작업에서 `public/sw.js` VERSION을 `rw-v65`로.
- 모든 AI 응답은 검증 함수를 거친 뒤에만 화면에.

## Review Focus

1. 두 보호자가 같은 어르신 일지를 동시에(한쪽은 오프라인) 고침 → 날짜별로 합쳐져 어느 날도 사라지지 않아야 한다. → Task 6 `mergeDiary` 테스트.
2. 앱을 연 채로 내보내지거나 어르신이 삭제됨 → 다음 동기화가 `GONE`/`NOT_MEMBER`를 받아 그 어르신 사본을 지우고 고르기 목록을 새로 그림, 오류 화면 없음. → Task 2 테스트 + Task 6 `applyLoadResult` 테스트.
3. 실종 입력 도중 세션 만료(refresh 실패) → 로그인 화면으로 가되 `sessionStorage`의 진행 중 단서(`rw_clue`, `rw_utterance`)는 남고 로그인 후 원래 화면으로 돌아옴. → Task 5 `requireLogin` 테스트.
4. 오늘 GPS 점이 0·1개, 전부 정지, 속도 값 없음 → `lastMotion`이 `none`/`stayed`, 좌표에 NaN 없음, 후보 계산이 빈 배열·정상 값. → Task 10 테스트.
5. 초대 토큰 재사용·만료·이미 member인 사람이 수락 → 각각 `INVITE_USED`/`INVITE_EXPIRED`/`ok:true(already)`, 중복 member 행 없음. → Task 2 테스트.

---

## 병렬 실행 순서

서로 기다리지 않는 작업은 동시에 돌린다. 같은 파일을 고치는 작업은 같은 묶음에 넣지 않는다(9와 11은 `lib/prompts.js`·`api/diary.js`·`verify.js`가 겹쳐 순서대로).

| 묶음 | 동시에 하는 작업 | 기다리는 것 |
|---|---|---|
| 1 | Task 1(DB·토큰) · Task 4(어르신 앱) · Task 9(기억 꺼내기) · Task 10(예상 경로 계산) | 없음 |
| 2 | Task 2(계정 규칙) · Task 5(로그인) · Task 11 서버 부분(프롬프트·mode·`verifyCandidates`) | 1 |
| 3 | Task 3(`api/loc.js`) · Task 6(동기화) | 2 |
| 4 | Task 7(탭·설정·초대) | 3 |
| 5 | Task 8(기존 화면 옮기기) · Task 11 화면 부분 | 4 |
| 6 | Task 12(문서·호스트 요청서·버전) | 5 |

각 작업은 따로 작업 공간(git worktree)에서 하고, 묶음이 끝나면 합친 뒤 `npm test` 전체를 돌리고 다음 묶음으로 간다.

## File Structure

| 파일 | 책임 |
|---|---|
| `docs/supabase.sql` (수정) | 새 표 `elders`, `elder_members`, `elder_data`, `invites`, `revoked_devices` |
| `lib/auth.js` (새) | 요청의 Bearer 토큰 → Supabase 사용자 `{id,email}` |
| `lib/family.js` (새) | 계정 데이터 업무 규칙(권한·초대·충돌·삭제 규칙). `db`를 주입받아 테스트 가능 |
| `api/loc.js` (수정) | action 분배만. 기존 push/latest/places/clear + 새 action |
| `api/config.js` (수정) | `supabase: { url, anonKey }` 공개값 추가 |
| `api/diary.js` (수정) | mode `memory`, `candidates` |
| `lib/prompts.js` (수정) | `SYSTEM_MEMORY`/`userMemory`, `SYSTEM_CANDIDATES`/`userCandidates` |
| `public/lib/schema.js` (수정) | `MEMORY_TOPICS` |
| `public/lib/predict.js` (새) | 마지막 움직임·예상 경로·닿는 범위·후보 특징·기본 순서 (순수 함수) |
| `public/lib/verify.js` (수정) | `verifyCandidates`, `verifyMemory` |
| `public/js/auth.js` (새) | 가입·로그인·자동 로그인·비밀번호 찾기·로그아웃·이메일 저장 |
| `public/js/family.js` (새) | 어르신 목록·현재 어르신·동기화·병합·업로드 정리 |
| `public/js/shell.js` (새) | 상단 어르신 고르기 + 하단 탭 + 로그인 가드 |
| `public/js/common.js` (수정) | `store.set` 동기화 훅, 집 주소 어르신별 키, AI 동의 문구 |
| `public/login.html`, `public/settings.html`, `public/join.html`, `public/memory.html` (새) | 로그인 / 설정·초대·가족 / 초대 수락 / 기억 꺼내기 대화 |
| 기존 `public/*.html` (수정) | 셸 붙이기, `rw_track` 대신 현재 어르신 연결 코드, 후보지 표시 |
| `android/.../TrackerService.kt`, `MainActivity.kt` (수정) | 410이면 대기열 비우고 멈춤 + 안내 |
| `tests/*.test.js` (새), `package.json` (수정) | `"test": "node --test tests/"` |

---

### Task 1: DB 표 + 서버 토큰 확인 + 공개 설정

**Files:**
- Modify: `docs/supabase.sql`, `api/config.js`, `.env.example`, `package.json`
- Create: `lib/auth.js`, `tests/auth.test.js`

**Interfaces:**
- Produces: `userFromToken(token: string, fetchFn = fetch) -> Promise<{id: string, email: string} | null>`; `bearer(req) -> string | null`; `/api/config` 응답에 `supabase: { url: string|null, anonKey: string|null }`.

- [ ] **Step 1: SQL 추가** — `docs/supabase.sql` 끝에:
  - `elders(id uuid pk default gen_random_uuid(), label text not null, device_hash text unique, created_at timestamptz default now(), last_seen timestamptz default now())`
  - `elder_members(elder_id uuid references elders on delete cascade, user_id uuid not null, role text check (role in ('owner','member')), joined_at timestamptz default now(), primary key(elder_id,user_id))`
  - `elder_data(elder_id uuid pk references elders on delete cascade, profile jsonb, diary jsonb default '[]', incidents jsonb default '[]', updated_at timestamptz default now())`
  - `invites(token_hash text pk, elder_id uuid references elders on delete cascade, created_by uuid, expires_at timestamptz, used_at timestamptz)`
  - `revoked_devices(device_hash text pk, revoked_at timestamptz default now())`
  - 모두 `enable row level security`, 정책 없음. 주석: "Auth → Providers → Email: Confirm email 끔".
- [ ] **Step 2: 실패하는 테스트** `tests/auth.test.js`
  ```js
  test("valid token → user", async () => {
    const f = async (url, o) => ({ ok: true, json: async () => ({ id: "u1", email: "a@b.c" }) });
    assert.deepEqual(await userFromToken("t", f), { id: "u1", email: "a@b.c" });
  });
  test("401 → null", async () => assert.equal(await userFromToken("t", async () => ({ ok: false, status: 401 })), null));
  test("empty token → null without fetch", async () => assert.equal(await userFromToken("", () => { throw 1; }), null));
  test("bearer parses header", () => assert.equal(bearer({ headers: { authorization: "Bearer abc" } }), "abc"));
  ```
- [ ] **Step 3:** `package.json`에 `"test": "node --test tests/"` 추가. `npm test` → FAIL(모듈 없음).
- [ ] **Step 4: `lib/auth.js` 구현** — `GET ${SUPABASE_URL}/auth/v1/user`, 헤더 `apikey: SUPABASE_ANON_KEY`, `Authorization: Bearer <token>`, 6초 타임아웃, 실패·예외는 `null`. 테스트에서 env가 없어도 동작하도록 URL은 호출 시 읽는다.
- [ ] **Step 5:** `api/config.js`에 `supabase: { url: process.env.SUPABASE_URL || null, anonKey: process.env.SUPABASE_ANON_KEY || null }`. `.env.example`에 `SUPABASE_ANON_KEY` 설명 추가.
- [ ] **Step 6:** `npm test` → PASS.
- [ ] **Step 7: Commit** `feat(auth): supabase tables for guardian accounts, server token check, public auth config`

---

### Task 2: 계정 데이터 규칙 `lib/family.js`

**Files:**
- Create: `lib/family.js`, `tests/family.test.js`

**Interfaces:**
- Consumes: `db(method, path, body?, prefer?)` 형식(`lib/kv.js`와 같음) — 테스트는 메모리 가짜 db.
- Produces: `familyApi({ db, now = () => new Date(), randomToken }) ->` 아래 async 함수들. 모두 `{ok:true,...}` 또는 `{ok:false, reason}`.
  - `me(user) -> {ok, elders:[{id,label,role}]}` 
  - `createElder(user, {label}) -> {ok, elder:{id,label,role:"owner"}, deviceCode}` (deviceCode = 16글자 `A-Z2-7`, 서버엔 해시만)
  - `load(user, elderId) -> {ok, data:{profile,diary,incidents,updated_at}}` | `NOT_MEMBER` | `GONE`
  - `save(user, elderId, {profile?, diary?, incidents?, base}) -> {ok, updated_at}` | `{ok:false, reason:"CONFLICT", data}`
  - `inviteCreate(user, elderId) -> {ok, token, expires_at}`
  - `inviteAccept(user, token) -> {ok, elderId, already?}` | `INVITE_USED` | `INVITE_EXPIRED` | `INVITE_NOT_FOUND`
  - `members(user, elderId) -> {ok, members:[{user_id, email?, role, joined_at, me}]}` (email은 Auth admin 조회가 필요하면 생략하고 `me` 표시만 — 빌더 판단)
  - `removeMember(user, elderId, userId)` (owner만, 자기 자신 불가 → `leave` 사용)
  - `leave(user, elderId)` — owner가 빠지면 가장 먼저 들어온 member가 owner, 마지막이면 `deleteElder`와 같은 삭제
  - `deleteElder(user, elderId)` (owner만) — elders 삭제(cascade) + 그 `device_hash`의 `loc_events` 삭제 + `revoked_devices`에 해시 추가
  - `resetDevice(user, elderId) -> {ok, deviceCode}` (owner만) — 옛 해시 `revoked_devices`로
  - `withdraw(user)` — 모든 어르신에서 `leave` 후 `{ok, deleteAuthUser:true}` (Auth 계정 삭제는 Task 3이 service_role로 `DELETE /auth/v1/admin/users/{id}`)
  - `deviceHashOf(code) -> string` (기존 `devOf`와 같은 식 `sha256("rw-loc:"+code).slice(0,32)` — 기존 연결 코드와 호환)
  - `importDevice(user, elderId, code)` — 첫 로그인 때 기존 `rw_track` 코드를 그 어르신 `device_hash`로 (이미 다른 어르신이 쓰면 `DEVICE_TAKEN`)
  - 모든 member 요청은 `elders.last_seen` 갱신(지우는 기준 아님, 표시용).

- [ ] **Step 1: 실패하는 테스트** — 가짜 db(표별 배열, PostgREST 경로의 `eq.`/`lt.` 필터만 해석) 위에서:
  ```js
  test("owner creates elder, member cannot load other elder", ...)        // NOT_MEMBER
  test("save with stale base → CONFLICT with server data", ...)           // base < updated_at
  test("save with current base → ok, updated_at advances", ...)
  test("invite accept twice → INVITE_USED; expired → INVITE_EXPIRED", ...)
  test("accept by existing member → ok already, one member row", ...)
  test("owner leaves → earliest member becomes owner", ...)
  test("last member leaves → elder, data, invites gone; device revoked", ...)
  test("member cannot removeMember/deleteElder/resetDevice → NOT_OWNER", ...)
  test("deleted elder → load returns GONE", ...)
  test("deviceHashOf matches old devOf for same code", ...)
  ```
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** `lib/family.js` 구현. 초대 토큰은 `randomToken()`(기본 `crypto.randomBytes(16).toString("base64url")`), 저장은 `sha256` 해시. 만료 24시간.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(family): guardian/elder membership, invites, conflict-checked save, deletion rules`

---

### Task 3: `api/loc.js` action 연결

**Files:**
- Modify: `api/loc.js`
- Create: `tests/loc-route.test.js`

**Interfaces:**
- Consumes: Task 1 `bearer`, `userFromToken`; Task 2 `familyApi`, `deviceHashOf`.
- Produces: `export async function route(body, { user, db, fam }) -> {status, body}` (handler는 이것을 감싼다). 새 action 이름(브라우저 Task 6이 그대로 씀):
  `me` · `elder.create {label}` · `data.load {elderId}` · `data.save {elderId, profile?, diary?, incidents?, base}` · `invite.create {elderId}` · `invite.accept {token}` · `members.list {elderId}` · `members.remove {elderId, userId}` · `elder.leave {elderId}` · `elder.delete {elderId}` · `device.reset {elderId}` · `device.import {elderId, key}` · `account.withdraw` · `latest {elderId, limit}` · `places {elderId}` · `clear {elderId}`(위치만)
  - 로그인 없이 허용: `push {key, p}`(어르신 앱), `latest {key, limit:1}`(limit 강제 1).
  - `push`: `revoked_devices`에 해시가 있으면 `410 {ok:false, reason:"GONE"}`. 없으면 지금처럼 저장(모르는 코드도 받음).
  - 로그인 필요 action에 토큰 없음/무효 → `401 {ok:false, reason:"AUTH"}`.

- [ ] **Step 1: 실패하는 테스트** — `route`에 가짜 `fam`/`db`:
  ```js
  test("revoked device push → 410 GONE", ...)
  test("unknown device push → 201", ...)
  test("data.load without user → 401 AUTH", ...)
  test("latest by key without user → limit forced to 1", ...)
  test("latest by elderId requires membership", ...)
  test("unknown action → 400 BAD_ACTION", ...)
  ```
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** `api/loc.js`를 `route` + 얇은 handler로 정리. 기존 `purge`, 30일, `places` 계산 그대로. `account.withdraw`의 Auth 삭제는 `fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {method:"DELETE", headers: service_role})`.
- [ ] **Step 4:** `npm test` → PASS. `npm run dev` 후 `curl -X POST localhost:3000/api/loc -d '{"action":"me"}' -H 'content-type: application/json' -H 'origin: http://localhost:3000'` → `{"ok":false,"reason":"AUTH"}`.
- [ ] **Step 5: Commit** `feat(loc): account actions on /api/loc, revoked device push returns 410`

---

### Task 4: 어르신 앱 — 410이면 멈춤

**Files:**
- Modify: `android/app/src/main/java/app/rememberway/tracker/TrackerService.kt:164-175`, `MainActivity.kt`(상태 문구)

- [ ] **Step 1:** `flush()`의 `when`에 `code == 410 ->` 추가: 대기열 파일 비우기, `Store.pending(this,0)`, `Store.status(this, "가족이 연결을 끊었어요. 보호자에게 새 연결 코드를 받아 넣어 주세요.")`, 서비스 중지(`running=false; stopSelf()`), return.
- [ ] **Step 2:** 새 코드를 넣고 [시작]하면 다시 동작하는지 — `MainActivity` 흐름은 그대로(키 저장 → 서비스 시작).
- [ ] **Step 3:** push → GitHub Actions `android.yml` 빌드 성공 확인(`gh run watch`). 
- [ ] **Step 4: Commit** `feat(android): stop and tell elder when the link code is revoked (410)`

---

### Task 5: 로그인 (브라우저)

**Files:**
- Create: `public/js/auth.js`, `public/login.html`, `tests/auth-client.test.js`

**Interfaces:**
- Consumes: `/api/config` `supabase.url/anonKey`.
- Produces (`public/js/auth.js`):
  - `signUp(email, password) -> {ok, reason?}` (`POST /auth/v1/signup`), `signIn(email, password)` (`POST /auth/v1/token?grant_type=password`), `resetPassword(email)` (`POST /auth/v1/recover`, `redirect_to: location.origin + "/login?reset=1"`), `updatePassword(newPw)` (`PUT /auth/v1/user`)
  - `session() -> Promise<{access_token, user:{id,email}} | null>` — 저장된 세션(`localStorage "rw_session"`), 만료 60초 전이면 `grant_type=refresh_token`으로 갱신, 실패하면 `null`
  - `authFetch(path, body) -> Promise<json>` — `/api/loc`에 `Authorization: Bearer` 붙여 POST, 401이면 한 번 갱신 후 재시도, 그래도 401이면 `requireLogin()`
  - `signOut({ everywhere = false })` — `POST /auth/v1/logout`(`scope=global` if everywhere), 세션만 지움(데이터·`rw_email` 유지)
  - `savedEmail() / rememberEmail(email)` — `localStorage "rw_email"`
  - `requireLogin()` — `location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search)`; `sessionStorage`는 건드리지 않음
  - 순수 함수(테스트용): `needsRefresh(sess, nowSec) -> boolean`, `nextUrl(search) -> string`(같은 사이트 경로만, 아니면 `"/"`)
- 화면 `login.html`: 맨 위 112 고정 문구·빨간 버튼 → 이메일(저장값 미리 채움)·비밀번호·[로그인]·[가입]·[비밀번호 찾기]·"초대 링크를 받으셨나요? 링크를 눌러 들어오시면 됩니다". `?reset=1`이면 새 비밀번호 입력. 로그인 성공 → `rememberEmail` → `nextUrl`. 오류 문구 한국어(잘못된 비밀번호, 이미 가입된 이메일, 비밀번호 6자 이상).

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test("needsRefresh true within 60s of expiry", () => assert.equal(needsRefresh({ expires_at: 1000 }, 950), true));
  test("needsRefresh false when far", () => assert.equal(needsRefresh({ expires_at: 1000 }, 100), false));
  test("nextUrl keeps same-site path", () => assert.equal(nextUrl("?next=%2Freport%3Fx%3D1"), "/report?x=1"));
  test("nextUrl blocks other origins", () => assert.equal(nextUrl("?next=https%3A%2F%2Fevil.com"), "/"));
  ```
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** 구현. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: 수동 확인** (호스트 설정 후 배포 환경에서. 협업자 PC에는 Supabase 키가 없으므로 그 전엔 자동 테스트만): 가입 → 새로고침해도 로그인 유지 → 로그아웃 → 이메일 칸 미리 채워짐 → 비밀번호 찾기 메일 수신.
- [ ] **Step 6: Commit** `feat(login): email login with remembered email, auto-login, password reset`

---

### Task 6: 동기화 (브라우저)

**Files:**
- Create: `public/js/family.js`, `tests/sync.test.js`
- Modify: `public/js/common.js` (`store.set` 훅, 집 주소 키, AI 동의 문구)

**Interfaces:**
- Consumes: Task 5 `authFetch`, `session`; Task 3 action 이름.
- Produces (`public/js/family.js`):
  - `SYNCED = [KEYS.profile, KEYS.diary, KEYS.incidents]`
  - `currentElder() -> {id,label,role} | null` (`localStorage "rw_elder"`), `setCurrentElder(e)` — 바꾸면 SYNCED 키·`rw_track` 사본을 그 어르신 것으로 교체(어르신별 사본 `rw_cache:<elderId>`)
  - `listElders() -> Promise<[...]>` (`me`), `createElder(label)`, `pull() -> Promise<"ok"|"offline"|"gone">`, `push(key)`(디바운스 1초, 실패 시 `rw_dirty` 표시 후 다음 `pull` 전에 재시도)
  - 순수 함수: `mergeDiary(local, server) -> diary` (날짜별, 같은 날이면 `visited` 합집합), `sanitizeForUpload(key, value, home) -> value` (incidents의 `utterance`/`narrative` 원문 필드 제거, 집 좌표(`ARRIVE_M` 50m 안) 점 제거), `applyLoadResult(res, elderId) -> "ok"|"gone"` (`GONE`/`NOT_MEMBER`면 그 어르신 사본·`rw_elder` 삭제)
  - 계정 바뀜: 로그인 사용자 id가 `rw_owner_user`와 다르면 모든 `rw_cache:*`·SYNCED 키 삭제(집 주소·연결 코드 제외).
  - 첫 로그인 + 어르신 0명 + 이 폰에 기존 `rw_profile`이 있으면: "이 폰의 등록 정보를 새 어르신으로 올릴까요?" → `createElder(profile.honorific)` → `data.save` → `rw_track` 있으면 `device.import`.
- `common.js`: `store.set(key, v)` 끝에 `onSet?.(key, v)` 호출(`export function setStoreHook(fn)`). 집 주소 `HOME_KEY`를 `rw_home:<elderId>`(현재 어르신 없으면 기존 `rw_home`)로; 기존 값은 첫 어르신에 이동. AI 동의 창 문구 → "AI 서버는 저장하지 않습니다. 정리된 결과는 가족 계정으로만 공유됩니다".

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test("mergeDiary keeps days from both sides", () => assert.deepEqual(mergeDiary([{date:"2026-11-16",visited:["a"]}], [{date:"2026-11-17",visited:["b"]}]).map(d=>d.date), ["2026-11-16","2026-11-17"]));
  test("mergeDiary unions visited on same day", () => assert.deepEqual(mergeDiary([{date:"d",visited:["a"]}],[{date:"d",visited:["b","a"]}])[0].visited.sort(), ["a","b"]));
  test("sanitize drops utterance from incidents", () => assert.equal(sanitizeForUpload(KEYS.incidents, [{utterance:"x", clue:{}}], null)[0].utterance, undefined));
  test("sanitize drops points within 50m of home", ...);
  test("applyLoadResult GONE clears cache", ...);   // 가짜 localStorage
  ```
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** PASS.
- [ ] **Step 5: 수동 확인:** 브라우저 두 개(일반/시크릿)에 다른 계정 → 초대 전에는 서로 안 보임(Task 7 뒤 재확인).
- [ ] **Step 6: Commit** `feat(sync): per-elder shared data with conflict merge and upload sanitizing`

---

### Task 7: 셸(탭·어르신 고르기) + 설정 + 초대 수락

**Files:**
- Create: `public/js/shell.js`, `public/settings.html`, `public/join.html`
- Modify: `public/css/app.css`(탭바), `public/index.html`

**Interfaces:**
- Consumes: Task 5, 6.
- Produces: `mountShell({ tab: "live"|"find"|"memory"|"settings" }) -> Promise<{elder}>` — 로그인 안 됐으면 `requireLogin()`; 어르신 0명이면 "어르신 등록"(호칭 입력) 화면; 상단 `어르신: 아버지 ▾` 고르기(+ 새 어르신), 하단 고정 탭 3개(📍 `/track` · 🚨 `/report` · 📝 `/profile`), 오른쪽 위 ⚙ `/settings`. 시작 시 `pull()`.
- `index.html`: 로그인돼 있으면 `/track`… 대신 탭 홈으로 — 첫 화면은 셸 + 🚨 탭 강조 카드(112 + "지금 실종됐어요"), 로그인 안 돼 있으면 `/login`.
- `settings.html`: 가족 초대(QR = `${origin}/join?t=TOKEN`, cdnjs `qrcode-generator@1.4.4`로 그림 + [링크 보내기] Web Share + 만료 시각), 가족 목록(owner면 [내보내기]), 어르신 폰 연결 코드(보기·owner [다시 만들기]), [로그아웃] [모든 기기에서 로그아웃], [이 어르신에서 빠지기], owner [어르신 데이터 모두 지우기], [탈퇴]. 지우기·탈퇴는 확인 창 2번.
- `join.html`: `?t=` → 로그인 안 됐으면 `requireLogin()`(next에 토큰 유지) → `invite.accept` → 성공이면 그 어르신으로 `setCurrentElder` → `/track`. 실패 문구: 사용됨/만료/없음.

- [ ] **Step 1:** 구현 (UI — 자동 테스트 없음, 로직은 Task 5·6에 있음).
- [ ] **Step 2: 수동 확인 시나리오** — 계정 A: 가입→어르신 "아버지" 등록→설정에서 초대 QR. 계정 B(시크릿 창): 링크 열기→가입→아버지가 보임. A가 B 내보내기 → B 새로고침 시 아버지 사라짐(오류 화면 없음). 같은 링크 재사용 → "이미 사용된 초대예요".
- [ ] **Step 3: Commit** `feat(shell): bottom tabs, elder switcher, settings with QR invite, invite accept page`

---

### Task 8: 기존 화면을 계정·탭으로 옮기기

**Files:**
- Modify: `public/track.html`, `public/gps.html`, `public/find.html`, `public/report.html`, `public/confirm.html`, `public/summary.html`, `public/record.html`, `public/profile.html`, `public/diary.html`

- [ ] **Step 1:** 각 화면 첫 줄에서 `await mountShell({tab})` (track·gps·find → `live`, report·confirm·summary·record → `find`, profile·diary·memory → `memory`). 기존 `topbar`의 "← 처음"은 셸 탭으로 대체.
- [ ] **Step 2:** `track.html`: 연결 코드 만들기 화면 제거 → 현재 어르신에 연결 코드가 없으면 "설정에서 어르신 폰 연결 코드를 만들어 주세요" + 링크. `latest`/`clear`는 `authFetch({action, elderId})`. 화면 안에 [자주 머문 곳 보기 →`/gps`], [목걸이 소리로 찾기 →`/find`] 버튼.
- [ ] **Step 3:** `gps.html`·`report.html`: `rw_track` 읽기 → `authFetch({action:"places"|"latest", elderId})`. 
- [ ] **Step 4:** `profile.html`·`diary.html`·`record.html`·`summary.html`: 코드 변경 없이 `store` 훅으로 동기화되는지 확인, 첫 화면 "이 기기의 등록 정보 모두 지우기" 링크 제거(설정으로 이동).
- [ ] **Step 5: 수동 확인** — 계정 A가 `/profile`에서 추억의 장소 "옛 직장" 추가 → 계정 B `/profile` 새로고침 시 보임 → B가 `/report`→`/summary`까지 갔을 때 "옛 직장"이 우선 확인 순서에 있음. 서버 끊김(오프라인 모드) → 마지막 사본으로 `/summary`까지 감. `npm run mock:fake` 정상.
- [ ] **Step 6: Commit** `feat(pages): existing screens use shared elder data inside the three tabs`

---

### Task 9: 기억 꺼내기 대화 (AI)

**Files:**
- Modify: `public/lib/schema.js`, `lib/prompts.js`, `api/diary.js`, `public/lib/verify.js`
- Create: `public/memory.html`, `tests/memory.test.js`

**Interfaces:**
- Produces:
  - `MEMORY_TOPICS = [{key:"old_home",label:"예전에 사시던 집·동네"},{key:"hometown",label:"고향"},{key:"old_work",label:"예전 직장·일하시던 곳"},{key:"market",label:"자주 가시던 시장·가게"},{key:"bath",label:"목욕탕·이발소·미용실"},{key:"religion",label:"교회·성당·절"},{key:"hospital",label:"다니시던 병원·복지관·경로당"},{key:"people",label:"자주 찾아가시던 친구·친척 집"}]` (순서 고정, 코드가 다음 주제를 고름)
  - `/api/diary` `{mode:"memory", honorific, topic, question, answer, knownPlaces}` → `{ok, places:[{name, evidence}], followup: string|null}`
  - `verifyMemory(raw, answer, knownPlaces) -> {places, followup}` — 이름이 `appearsInSource(name, answer)`가 아니면 버림, 이미 아는 이름 제외, followup은 160자 이하·물음표로 끝남·아니면 null.
- `memory.html`(📝 탭): 주제 질문(템플릿 "아버지께서 {label}은 어디셨나요?") → 음성/글 답 → 뽑힌 장소 카드(✎ 수정, ⚠ 표시, [저장]/[아니에요]) → AI followup이 있으면 한 번 더, 없으면 다음 주제. [건너뛰기] [그만하기]. 저장은 `profile.places.push({name, source:"memory", evidence:"기억 꺼내기: "+evidence})` → 동기화. AI 실패 시 같은 질문에 이름 직접 입력 칸.
- `profile.html`에 [기억 꺼내기 대화 시작] 버튼.

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test("drops place not in answer", () => assert.equal(verifyMemory({places:[{name:"부산역"}]}, "청주 육거리시장에 다니셨어요", []).places.length, 0));
  test("keeps place in answer", () => assert.equal(verifyMemory({places:[{name:"육거리시장",evidence:"다니셨어요"}]}, "청주 육거리시장에 다니셨어요", []).places[0].name, "육거리시장"));
  test("skips known place", () => assert.equal(verifyMemory({places:[{name:"육거리시장"}]}, "육거리시장", ["육거리시장"]).places.length, 0));
  test("followup must be a question ≤160", () => assert.equal(verifyMemory({places:[], followup:"x".repeat(200)+"?"}, "", []).followup, null));
  ```
- [ ] **Step 2:** FAIL → **Step 3:** 프롬프트(`SYSTEM_MEMORY`: 원문에 없는 장소 금지, 없으면 빈 배열, followup은 같은 주제를 더 구체화하는 질문 1개 또는 null, JSON 하나만) + mode + 검증 구현. MOCK_AI 응답도 추가(`lib/claude.js`의 모의 응답 방식 따름). → **Step 4:** PASS.
- [ ] **Step 5: 수동 확인** — `MOCK_AI=1`로 대화 한 바퀴, 배너 보임. 실제 키로 "아버지는 젊을 때 청주 육거리시장에서 장사하셨어요" → "육거리시장" 카드.
- [ ] **Step 6: Commit** `feat(memory): guided memory-place interview (AI extracts, code verifies)`

---

### Task 10: 예상 경로 계산 `public/lib/predict.js`

**Files:**
- Create: `public/lib/predict.js`, `tests/predict.test.js`

**Interfaces:**
- Consumes: `distM` (`public/lib/gps.js`), `WALK_SPEED` (`schema.js`).
- Produces:
  - `lastMotion(points) -> {state:"moving_lost"|"stayed"|"none", lat?, lng?, t?, speedMps?, bearingDeg?}` — points는 `{t(ms), lat, lng, speed_kmh?}` 아무 순서. 0개 → `none`. 마지막 점 `speed_kmh < 1` 또는 마지막 2점 거리 < 30m이고 간격 ≥ 3분 → `stayed`. 그 밖엔 최근 최대 6점(마지막 점과 10분 이내)으로 속도(점 속도 중앙값, 없으면 거리/시간)·방위각(첫→마지막 점) — 계산 불가(1점·속도 0)면 `stayed`(좌표만).
  - `projectPath(motion, nowMs, stepMin = 10) -> [{t, lat, lng}]` — `moving_lost`일 때만, 마지막 시각부터 `nowMs`까지 `stepMin`마다 대권 목적지 공식으로 직선 이동. 그 밖엔 `[]`.
  - `reachM(motion, nowMs, speedMps = WALK_SPEED.normal) -> number` — `(now - t)/1000 * speed`, 음수면 0.
  - `candidateFeatures(motion, nowMs, places) -> [{...place, dist_m, bearing_diff_deg, reachable, path_dist_m}]` — places는 `{id, name, lat, lng, source, evidence?}`; 좌표 없는 장소 제외. `bearing_diff_deg`는 `moving_lost`일 때만(0~180), 아니면 null. `path_dist_m` = 예상 경로 점들까지 최소 거리. 모든 숫자 정수 반올림.
  - `fallbackOrder(features) -> features` — `reachable` 먼저, 그다음 `path_dist_m`(없으면 `dist_m`) 오름차순, 같으면 source `memory` 먼저.
- 파일 머리 주석: 직선 진행 가정의 근거 — Koester & Stooksbury(1995), Wilderness & Environmental Medicine (사용자 결정: 추가 확인 없이 기재).

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test("no points → none", () => assert.equal(lastMotion([]).state, "none"));
  test("single point → stayed, finite coords", () => { const m = lastMotion([{t:0,lat:36.6,lng:127.4}]); assert.equal(m.state,"stayed"); assert.ok(Number.isFinite(m.lat)); });
  test("last speed 0.5km/h → stayed", ...);
  test("moving north 1m/s → bearing ≈ 0, speed ≈ 1", ...);   // 점 6개, 10초 간격, 위도 +0.00009씩
  test("projectPath 30min at 1m/s north ends ≈1800m away", ...);
  test("projectPath for stayed → []", ...);
  test("candidateFeatures: place ahead has bearing_diff < 10, place behind > 170", ...);
  test("candidateFeatures skips places without coords", ...);
  test("fallbackOrder puts reachable memory place first", ...);
  ```
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(predict): last motion, projected path, reach and candidate features from GPS`

---

### Task 11: 예상 후보지 (AI 순서 + 화면)

**Files:**
- Modify: `lib/prompts.js`, `api/diary.js`, `public/lib/verify.js`, `public/summary.html`, `public/track.html`
- Create: `tests/candidates.test.js`

**Interfaces:**
- Consumes: Task 10 전부, Task 8 화면.
- Produces:
  - `/api/diary` `{mode:"candidates", honorific, motion:{state, minutes_since, speed_kmh, direction_8}, candidates:[{id, name, source, evidence, dist_m, bearing_diff_deg, reachable, path_dist_m}]}` (좌표 보내지 않음, 최대 15개) → `{ok, ranked:[{id, reason, warn:boolean}]}`
  - `verifyCandidates(raw, candidates, motion) -> ranked` — 목록 밖 id·중복 버림, 최대 3개; reason 200자 이하; reason 안의 숫자가 입력 JSON 숫자 집합에 없으면 `warn:true`(버리지 않음). 결과가 비면 `[]`(화면이 `fallbackOrder` 사용).
  - 방향 문자열 `direction_8`(북·북동·동·남동·남·남서·서·북서)은 코드가 계산해 보냄.
- 화면(`summary.html` 우선 확인 순서 위, `track.html` 지도 아래): 카드 "📍 예상 후보지 (14:05 북동쪽 시속 3km 이후 끊김, 40분 지남)" → 후보 1·2·3(이름, 출처 배지, 거리·방향, AI 이유, ⚠) + 지도에 예상 경로선(점선)·닿는 범위 원·후보 핀. `stayed`면 "14:05부터 그 자리에 머무시는 중일 수 있어요" + 마지막 위치 기준 가까운 순. GPS 없으면 보호자 단서(나간 시각·방향 `clue.direction`, 목적지)로 `motion`을 만들어 같은 흐름(방향 없으면 `stayed`처럼 거리 순). AI 실패·빈 결과 → `fallbackOrder` 3개, 이유는 코드 문장("가던 방향 1.2km, 지금 걸어서 닿을 수 있음").
  - 후보 모으기: 프로필 추억의 장소(지도 검색으로 좌표, 기존 `findPlace`), `places` 자주 머문 곳, 예상 경로 끝점 근처 `BASIC_KINDS`(`findNearby`, 반경 500m).

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test("drops ids not in candidates", () => assert.deepEqual(verifyCandidates({ranked:[{id:"zz",reason:"r"}]}, [{id:"c1"}], {}), []));
  test("keeps max 3, no duplicates", ...);
  test("number not in input → warn true", () => assert.equal(verifyCandidates({ranked:[{id:"c1",reason:"5km 떨어져 있어요"}]}, [{id:"c1",dist_m:1200}], {})[0].warn, true));
  test("number from input → warn false", ...);   // reason "1200m"
  ```
- [ ] **Step 2:** FAIL → **Step 3:** 프롬프트(`SYSTEM_CANDIDATES`: 목록 안에서만 최대 3개, 각 이유 1~2문장 존댓말, 입력에 없는 숫자·장소 금지, 출처가 추억의 장소면 evidence를 근거로 쓸 수 있음, JSON `{"ranked":[{"id":"","reason":""}]}` 하나만) + mode + MOCK 응답 + 화면. `api/diary.js`의 `BANNED`는 `gps` mode에만 쓰고 `candidates`에는 `/(확률|%|AI가 추천)/`. → **Step 4:** PASS.
- [ ] **Step 5: 수동 확인** — `mockTrack`(gps.js)으로 북동쪽 진행 후 끊긴 기록 + 그 방향 추억의 장소 1곳 → 후보 1번이 그곳, 경로선이 북동쪽. 키 없음 → 코드 순서로 같은 카드.
- [ ] **Step 6: Commit** `feat(candidates): projected-path candidate places ranked by AI within code-built list`

---

### Task 12: 문서·문구 정리, 버전

**Files:**
- Modify: `PRODUCT.md`(18·28행), `public/about.html`(26행), `public/index.html`(개인정보 3줄), `docs/REMEMBER_WAY_AI_구현전_결정표.md`(추가 결정 2026-11-17), `docs/supabase.sql` 주석(“이름·주소·일지 내용은 저장하지 않는다” 문장 갱신), `lib/kv.js` 머리 주석, `public/sw.js`(`rw-v65`, 새 HTML·JS 캐시 목록), `.env.example`

- [ ] **Step 1:** "위치를 예측하지 않는다"·금지어 "예측" → "GPS 예상 경로로 후보지를 만들고, 계산은 코드·순서와 이유는 AI·검증은 코드". 개인정보 3줄 → "이름 안 묻음 / 사진 저장 안 함 / 이메일과 가족이 저장한 정보만 서버에, 가족만 봄".
- [ ] **Step 2:** 결정표에 이번 변경(계정·탭·기억 꺼내기·예상 후보지·로그인 필수·로그아웃 보존·자동 삭제는 GPS만)과 이유를 날짜와 함께 기록.
- [ ] **Step 3:** **호스트 설정 요청서** `docs/호스트_설정_요청_2026-11-17.md` 작성 — 협업자는 Supabase·Vercel에 접근할 수 없으므로 호스트가 그대로 따라 할 수 있게 순서대로: ① Supabase SQL Editor에서 `docs/supabase.sql`의 새 부분 Run ② Auth → Providers → Email → "Confirm email" 끔 ③ Auth → URL Configuration → Site URL·Redirect URL에 `https://<도메인>/login?reset=1` 추가 ④ Supabase → Settings → API의 anon(public) 키를 Vercel 환경변수 `SUPABASE_ANON_KEY`로 추가(Production·Preview) ⑤ Redeploy ⑥ GitHub 릴리스 `tracker-apk`의 새 APK를 어르신 폰에 다시 설치 ⑦ 확인: 가입 → 초대 → 두 번째 계정에서 같은 어르신 보임. 각 단계에 "잘 됐는지 보는 법"과 안 될 때 증상 한 줄. 본선 시연 점검표(시연 계정 2개·초대 완료·어르신 폰 연결 코드)도 이 문서 끝에.
- [ ] **Step 4:** `npm test` 전부 PASS, `npm run mock:fake` 정상, `grep -rn "rw_track" public` 결과가 `family.js`(첫 로그인 가져오기) 외 없음.
- [ ] **Step 5: Commit** `docs: accounts, shared data, memory interview and candidate places replace device-only and no-prediction rules; sw v65`
