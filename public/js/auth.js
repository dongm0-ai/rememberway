// 보호자 로그인 (브라우저) — Supabase Auth REST(/auth/v1/...)를 fetch로 직접 부른다. 의존성 0.
// - 세션(access/refresh token)은 이 기기 localStorage "rw_session"에 둔다. 앱을 열면 session()이 만료 60초 전에 알아서 갱신한다(자동 로그인).
// - 이메일은 "rw_email"에 따로 기억한다. 로그아웃은 세션만 지운다 (등록 정보·이메일은 그대로).
// - import 할 때는 window/localStorage/location 을 건드리지 않는다 (Node 테스트에서 순수 함수를 가져다 쓸 수 있게). 모두 호출할 때 읽는다.
// - 서버(api/loc.js)는 Authorization: Bearer <access_token> 으로 누구인지 확인한다.

const SESSION_KEY = "rw_session";
const EMAIL_KEY = "rw_email";
const REJECTED_KEY = "rw_login_rejected"; // 서버가 갱신 직후 토큰도 거부했을 때 찍는 시각 — /login 이 곧바로 되돌려 보내는 무한 반복을 막는다
const CONFIG_KEY = "rw_config"; // common.js loadConfig 와 같은 sessionStorage 캐시
const REFRESH_MARGIN_SEC = 60;
const REJECTED_WINDOW_SEC = 120;

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- 저장소 (모두 호출 시점에 읽고, 막혀 있어도 죽지 않는다)
const lsGet = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch {} };
const lsDel = (k) => { try { globalThis.localStorage?.removeItem(k); } catch {} };

// ---------------------------------------------------------------- 순수 함수
/** 만료 60초 전부터는 갱신이 필요하다. 만료 시각을 모르면 갱신 대상 */
export function needsRefresh(sess, now = nowSec()) {
  const exp = Number(sess?.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) return true;
  return exp - now <= REFRESH_MARGIN_SEC;
}

/** "?next=/report%3Fx%3D1" → "/report?x=1". 같은 사이트 안의 경로만 허용하고, 아니면 "/" (열린 리디렉션 방지). 로그인 화면으로 되돌아가지도 않는다 */
export function nextUrl(search) {
  try {
    const raw = new URLSearchParams(String(search ?? "")).get("next");
    if (!raw || raw[0] !== "/" || raw[1] === "/" || /[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
    const u = new URL(raw, "http://same.site");
    if (u.origin !== "http://same.site") return "/";
    if (/^\/login(\.html)?\/?$/i.test(u.pathname)) return "/"; // 점 경로(/a/../login)도 정리된 뒤의 경로로 본다
    const out = u.pathname + u.search + u.hash;
    // 마지막 방어선: "/.//evil.com", "/%2e//evil.com" 처럼 점 경로가 정리되면 "//evil.com" 이 되는 경우까지 막는다.
    // 결과는 반드시 "/" 로 시작하고 그 다음이 "/" 나 "\" 가 아니어야 한다 (같은 사이트의 경로)
    return /^\/(?![\/\\])/.test(out) ? out : "/";
  } catch { return "/"; }
}

/** Supabase 응답 → 저장용 세션 {access_token, refresh_token, expires_at, user:{id,email}}. 토큰이 없으면 null.
 *  만료 시각은 "이 기기의 지금 + expires_in" — 서버가 준 expires_at 은 기기 시계가 틀리면 어긋나므로 expires_in 이 없을 때만 쓴다 */
export function toSession(d, now = nowSec(), prevUser = null) {
  if (!d || typeof d.access_token !== "string" || !d.access_token || typeof d.refresh_token !== "string" || !d.refresh_token) return null;
  const at = Number(d.expires_at), ei = Number(d.expires_in);
  const expires_at = ei > 0 ? now + ei : at > 0 ? at : now + 3600;
  const u = d.user?.id ? d.user : prevUser;
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at, user: { id: u?.id ?? "", email: u?.email ?? "" } };
}

/** 메일 링크로 들어온 주소의 #해시 → {type, tokens} | {error} | null (해시에 로그인 정보가 없으면 null) */
export function sessionFromHash(hash, now = nowSec()) {
  const h = String(hash ?? "").replace(/^#/, "");
  if (!h) return null;
  const p = new URLSearchParams(h);
  if (p.get("error") || p.get("error_code")) {
    return { error: p.get("error_code") === "otp_expired" || /expired|invalid/i.test(p.get("error_description") || "") ? "LINK_EXPIRED" : "LINK_INVALID" };
  }
  const at = p.get("access_token"), rt = p.get("refresh_token");
  if (!at || !rt) return null;
  const ea = Number(p.get("expires_at")), ei = Number(p.get("expires_in"));
  return { type: p.get("type") || "", tokens: { access_token: at, refresh_token: rt, expires_at: ei > 0 ? now + ei : ea > 0 ? ea : now + 3600 } };
}

/** Supabase Auth 오류(HTTP 상태 + 본문) → 우리 쪽 reason 코드 */
export function reasonFromError(status, data) {
  const d = data && typeof data === "object" ? data : {};
  const strs = (...v) => v.filter((x) => typeof x === "string").join(" ").toLowerCase();
  const code = strs(d.error_code, d.code, d.error);
  const msg = strs(d.msg, d.message, d.error_description);
  const has = (re) => re.test(code) || re.test(msg);
  if (status === 429 || has(/rate_limit|rate limit|too many/)) return "RATE_LIMITED";
  if (has(/user_already_exists|email_exists|already registered|already been registered/)) return "EMAIL_EXISTS";
  if (has(/same_password|different from the old password/)) return "SAME_PASSWORD"; // weak_password 보다 먼저 (문구가 비슷하다)
  if (has(/weak_password|at least \d+ characters|password should/)) return "WEAK_PASSWORD";
  if (has(/email_not_confirmed|email not confirmed/)) return "EMAIL_NOT_CONFIRMED";
  if (has(/signup_disabled|signups? not allowed|signup is disabled/)) return "SIGNUP_DISABLED";
  if (has(/invalid_credentials|invalid login credentials/)) return "INVALID_CREDENTIALS";
  if (has(/email_address_invalid|validate email|invalid email|email address .* is invalid|invalid format/)) return "INVALID_EMAIL";
  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

const TEXTS = {
  INVALID_CREDENTIALS: "이메일이나 비밀번호가 맞지 않아요. 다시 확인해 주세요.",
  EMAIL_EXISTS: "이미 가입된 이메일이에요. 비밀번호를 넣고 [로그인]을 눌러 주세요.",
  WEAK_PASSWORD: "비밀번호는 6자 이상으로 정해 주세요.",
  INVALID_EMAIL: "이메일 주소를 다시 확인해 주세요.",
  EMAIL_NOT_CONFIRMED: "이메일 확인이 아직이에요. 받은 메일의 링크를 눌러 주세요.",
  RATE_LIMITED: "요청이 너무 많았어요. 잠시 뒤에 다시 해 주세요.",
  SAME_PASSWORD: "이전과 다른 비밀번호로 정해 주세요.",
  SIGNUP_DISABLED: "지금은 새로 가입할 수 없어요.",
  NETWORK: "인터넷 연결을 확인해 주세요.",
  TIMEOUT: "서버 응답이 늦어요. 잠시 뒤에 다시 해 주세요.",
  NOT_CONFIGURED: "로그인 서버가 아직 설정되지 않았어요 (관리자 설정 필요)",
  NEED_LOGIN: "로그인 시간이 지났어요. 다시 로그인해 주세요.",
  UNAUTHORIZED: "로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.",
  LINK_EXPIRED: "비밀번호를 바꾸는 링크가 만료됐거나 이미 썼어요. [비밀번호 찾기]로 메일을 다시 받아 주세요.",
  LINK_INVALID: "비밀번호를 바꾸는 링크를 열지 못했어요. [비밀번호 찾기]로 메일을 다시 받아 주세요.",
  NO_LINK: "메일로 받은 링크를 눌러서 들어와 주세요.",
  SERVER: "서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요.",
  UNKNOWN: "문제가 생겼어요. 잠시 뒤에 다시 해 주세요.",
};
/** 화면에 보일 한국어 오류 문구 (모르는 reason 이면 일반 문구) */
export const reasonText = (reason) => TEXTS[reason] || TEXTS.UNKNOWN;

// ---------------------------------------------------------------- 이메일 기억
export function savedEmail() { return lsGet(EMAIL_KEY) || ""; }
export function rememberEmail(email) { const e = String(email ?? "").trim(); if (e) lsSet(EMAIL_KEY, e); }

// ---------------------------------------------------------------- 저장된 세션
function readSession() {
  const raw = lsGet(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s.access_token === "string" && typeof s.refresh_token === "string" ? s : null;
  } catch { return null; }
}
const saveSession = (s) => { lsSet(SESSION_KEY, JSON.stringify(s)); lsDel(REJECTED_KEY); };
const dropSession = () => { lsDel(SESSION_KEY); lsDel(REJECTED_KEY); };
// 호출한 쪽에는 refresh token 을 넘기지 않는다
const publicSession = (s) => ({ access_token: s.access_token, expires_at: s.expires_at, user: { id: s.user?.id ?? "", email: s.user?.email ?? "" } });

/** 네트워크 없이 이 폰에 저장된 로그인 정보만 본다 (만료돼도 그대로). 서버 장애 때 "이 폰의 마지막 사본" 판단에 쓴다. 없으면 null */
export function storedSession() { const s = readSession(); return s ? publicSession(s) : null; }

/** 서버가 방금 갱신한 토큰도 거부해서 로그인 화면으로 보낸 직후인가 (login.html 이 자동으로 되돌려 보내지 않게) */
export function recentlyRejected(now = nowSec()) {
  const t = Number(lsGet(REJECTED_KEY));
  return Number.isFinite(t) && t > 0 && now - t < REJECTED_WINDOW_SEC;
}

// ---------------------------------------------------------------- 서버 주소 (/api/config 의 supabase.url / anonKey)
const pickSupabase = (c) => {
  const s = c?.supabase;
  return s && typeof s.url === "string" && s.url && typeof s.anonKey === "string" && s.anonKey ? { url: s.url.replace(/\/+$/, ""), anonKey: s.anonKey } : null;
};
const netReason = (e) => (e?.name === "AbortError" ? "TIMEOUT" : "NETWORK");
async function timedFetch(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
// common.js 의 loadConfig 는 실패하면 {ai:{}} 를 돌려줘서 "설정 안 됨"과 "네트워크 끊김"을 구분할 수 없고, 설정 전에 캐시된 값을 다시 확인하지도 않는다.
// 그래서 같은 sessionStorage 캐시(rw_config)를 읽되, 로그인 정보가 들어 있을 때만 믿고 아니면 새로 받는다.
async function authConfig() {
  let cached = null;
  try { cached = JSON.parse(globalThis.sessionStorage?.getItem(CONFIG_KEY) || "null"); } catch {}
  const hit = pickSupabase(cached);
  if (hit) return { ok: true, ...hit };
  let c;
  try { c = await (await timedFetch("/api/config", { cache: "no-store" }, 8000)).json(); } catch (e) { return { ok: false, reason: netReason(e) }; }
  const sb = pickSupabase(c);
  if (!sb) return { ok: false, reason: "NOT_CONFIGURED" };
  try { globalThis.sessionStorage?.setItem(CONFIG_KEY, JSON.stringify(c)); } catch {}
  return { ok: true, ...sb };
}
/** 로그인 서버를 쓸 수 있나? → {ok:true} | {ok:false, reason:"NOT_CONFIGURED"|"NETWORK"|"TIMEOUT"} */
export async function authReady() { const c = await authConfig(); return c.ok ? { ok: true } : { ok: false, reason: c.reason }; }

/** Supabase Auth 호출. → {ok, status, data} | {ok:false, status, reason, data?}. status 0 = 요청이 나가지 못함 */
async function gotrue(path, { method = "POST", body, token } = {}) {
  const cfg = await authConfig();
  if (!cfg.ok) return { ok: false, status: 0, reason: cfg.reason };
  const headers = { apikey: cfg.anonKey };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await timedFetch(`${cfg.url}/auth/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { return { ok: false, status: 0, reason: netReason(e) }; }
  let data = null;
  try { data = await res.json(); } catch {} // 로그아웃은 본문이 없다 (204)
  if (res.ok) return { ok: true, status: res.status, data: data ?? {} };
  return { ok: false, status: res.status, reason: reasonFromError(res.status, data), data };
}

// ---------------------------------------------------------------- 가입·로그인·비밀번호
export async function signUp(email, password) {
  const r = await gotrue("/signup", { body: { email: String(email ?? "").trim(), password } });
  if (!r.ok) return { ok: false, reason: r.reason };
  const s = toSession(r.data);
  if (s) { saveSession(s); return { ok: true }; }
  // 세션이 없다 = 서버가 "이메일 확인"을 켜 둔 경우. 이미 가입된 이메일이면 identities 가 비어 있다.
  const u = r.data.user || r.data;
  if (Array.isArray(u?.identities) && u.identities.length === 0) return { ok: false, reason: "EMAIL_EXISTS" };
  return { ok: true, confirm: true };
}

export async function signIn(email, password) {
  const r = await gotrue("/token?grant_type=password", { body: { email: String(email ?? "").trim(), password } });
  if (!r.ok) return { ok: false, reason: r.reason };
  const s = toSession(r.data);
  if (!s) return { ok: false, reason: "UNKNOWN" };
  saveSession(s);
  return { ok: true };
}

/** 비밀번호 바꾸는 메일. 메일의 링크는 /login?reset=1 로 돌아온다 (Supabase 콘솔 Redirect URLs 에 허용 필요). 없는 이메일이어도 서버는 ok */
export async function resetPassword(email) {
  const to = encodeURIComponent((globalThis.location?.origin ?? "") + "/login?reset=1");
  const r = await gotrue(`/recover?redirect_to=${to}`, { body: { email: String(email ?? "").trim() } });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export async function updatePassword(newPw) {
  const s = await session();
  if (!s) return { ok: false, reason: "NEED_LOGIN" };
  const r = await gotrue("/user", { method: "PUT", body: { password: newPw }, token: s.access_token });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** 비밀번호 메일 링크(#access_token=…&type=recovery)로 들어왔을 때: 그 토큰을 세션으로 저장한다. → {ok} | {ok:false, reason} */
export async function acceptRecoveryLink(hash) {
  const r = sessionFromHash(hash);
  if (!r || (!r.error && r.type !== "recovery")) return { ok: false, reason: "NO_LINK" };
  if (r.error) return { ok: false, reason: r.error };
  const u = await gotrue("/user", { method: "GET", token: r.tokens.access_token });
  if (!u.ok) return { ok: false, reason: u.status === 401 || u.status === 403 ? "LINK_EXPIRED" : u.reason };
  const s = toSession({ ...r.tokens, user: u.data });
  if (!s) return { ok: false, reason: "LINK_INVALID" };
  saveSession(s);
  return { ok: true };
}

// ---------------------------------------------------------------- 세션 (자동 로그인)
let refreshing = null; // 갱신은 한 번에 하나만 — refresh token 은 쓰면 바뀌므로 동시에 두 번 보내면 한쪽이 실패한다

// 서버가 "이 토큰은 안 된다"고 답한 것인가 (일시 장애·시간 초과·요청 과다는 제외)
const isRejection = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

// 브라우저 탭끼리도 한 번에 하나만 (Web Locks). 지원하지 않으면 탭 안에서만 한 번에 하나
const withRefreshLock = (fn) => { const l = globalThis.navigator?.locks; return l && typeof l.request === "function" ? l.request("rw_refresh", fn) : fn(); };

async function doRefresh(stale) {
  const cur = readSession();
  if (!cur) return null;
  if (cur.refresh_token !== stale.refresh_token && !needsRefresh(cur)) return publicSession(cur); // 기다리는 사이 다른 탭이 이미 갱신했다
  const sent = cur.refresh_token;
  const r = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: sent } });
  // 네트워크를 기다리는 사이 저장소가 바뀌었는지 다시 본다
  const now = readSession();
  if (!now) return null; // 그 사이 로그아웃했다 — 늦게 온 응답으로 로그인이 되살아나면 안 된다
  if (now.refresh_token !== sent) return publicSession(now); // 다른 탭(또는 새 로그인)이 이미 새 세션을 저장했다 — 우리 응답이나 거부는 무시하고 그 세션을 쓴다
  if (r.ok) {
    const s = toSession(r.data, nowSec(), cur.user);
    if (s) { saveSession(s); return publicSession(s); }
    return null;
  }
  if (isRejection(r.status)) { dropSession(); return null; } // 로그아웃됐거나 다른 기기에서 "모든 기기 로그아웃" — 다시 로그인해야 한다
  return cur.expires_at > nowSec() ? publicSession(cur) : null; // 일시 장애: 세션은 지우지 않는다. 아직 유효하면 그대로 쓴다
}

function refreshSession(stale) {
  if (refreshing) return refreshing;
  const p = withRefreshLock(() => doRefresh(stale));
  refreshing = p;
  const done = () => { if (refreshing === p) refreshing = null; };
  p.then(done, done);
  return p;
}

/** 로그인돼 있으면 {access_token, expires_at, user:{id,email}}, 아니면 null. 만료 60초 전이면 먼저 갱신한다 */
export async function session() {
  const s = readSession();
  if (!s) return null;
  if (!needsRefresh(s)) return publicSession(s);
  return refreshSession(s);
}

export function requireLogin() {
  const loc = globalThis.location;
  loc.href = "/login?next=" + encodeURIComponent(loc.pathname + loc.search); // sessionStorage(진행 중이던 단서)는 건드리지 않는다
}

// ---------------------------------------------------------------- 서버 함수 호출
async function postJson(url, body, token) {
  try {
    const res = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) }, 16000);
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401) return { status: 401 };
    if (data && typeof data === "object") return { status: res.status, data: res.ok || "ok" in data ? data : { ...data, ok: false } };
    return { status: res.status, data: res.ok ? { ok: true } : { ok: false, reason: `HTTP_${res.status}` } };
  } catch (e) { return { status: 0, data: { ok: false, reason: netReason(e) } }; }
}

/**
 * 로그인이 필요한 서버 함수 호출. authFetch({action:"me"}) → /api/loc, authFetch("/api/loc", {action:"me"}) 도 된다.
 * 토큰은 Authorization 헤더로. 401이면 토큰을 한 번 갱신해 다시 보내고, 그래도 401이면 로그인 화면(requireLogin).
 * 네트워크 오류 등은 던지지 않고 {ok:false, reason}으로 돌려준다.
 */
export async function authFetch(pathOrBody, maybeBody) {
  const hasPath = typeof pathOrBody === "string";
  const url = !hasPath ? "/api/loc" : pathOrBody.startsWith("/") ? pathOrBody : `/api/${pathOrBody}`;
  if (!/^\/api\/[\w-]+$/.test(url)) return { ok: false, reason: "BAD_PATH" }; // 토큰을 우리 서버 함수 밖으로 보내지 않는다
  const body = hasPath ? maybeBody : pathOrBody;

  const s = await session();
  if (!s) {
    if (readSession()) return { ok: false, reason: "NETWORK" }; // 갱신이 일시적으로 안 된 것뿐 — 세션이 남아 있으니 로그인 화면으로 보내지 않는다
    requireLogin(); return { ok: false, reason: "NEED_LOGIN" };
  }
  const usedRefreshToken = readSession()?.refresh_token ?? ""; // 이 요청을 보낸 세션 (그 사이 다른 탭이 갱신했는지 알아보려고)
  let r = await postJson(url, body, s.access_token);
  if (r.status !== 401) return r.data;

  const s2 = await refreshSession({ refresh_token: usedRefreshToken });
  if (!s2) {
    if (readSession()) return { ok: false, reason: "NETWORK" }; // 갱신이 일시적으로 안 됐을 뿐 — 세션은 남아 있다
    requireLogin(); return { ok: false, reason: "UNAUTHORIZED" }; // 갱신이 거부됨 → 다시 로그인
  }
  if (s2.access_token === s.access_token) return { ok: false, reason: "NETWORK" }; // 새 토큰을 못 받았다 (일시 장애)
  r = await postJson(url, body, s2.access_token);
  if (r.status !== 401) return r.data;
  lsSet(REJECTED_KEY, String(nowSec())); // 새 토큰도 거부 = 서버 쪽 문제. login.html 이 자동으로 되돌려 보내지 않게 표시
  requireLogin();
  return { ok: false, reason: "UNAUTHORIZED" };
}

/** 로그아웃. 이 기기 세션만 지운다 (등록 정보·이메일 기억은 그대로). everywhere 면 서버에서 모든 기기의 로그인을 끊는다. → {ok:true, revoked} (revoked=false 면 서버에는 못 알림) */
export async function signOut({ everywhere = false } = {}) {
  const s = await session().catch(() => null);
  let revoked = false;
  if (s) revoked = (await gotrue(`/logout?scope=${everywhere ? "global" : "local"}`, { token: s.access_token })).ok;
  dropSession();
  return { ok: true, revoked };
}
