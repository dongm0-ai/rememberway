// 공통: 저장(localStorage/sessionStorage), API 호출(10초 타임아웃), 음성 입력, 작은 UI 도우미
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
  sget(key, fallback = null) { try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  sset(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
export const KEYS = { profile: "rw_profile", diary: "rw_diary", incidents: "rw_incidents", clue: "rw_clue", utterance: "rw_utterance", mode: "rw_mode", config: "rw_config" };

/** 서버 함수 호출. 10초 넘으면 {ok:false, reason:"TIMEOUT"}. 네트워크 끊김도 ok:false → 서식 모드 */
export async function api(name, body, timeoutMs = 16000) { // 서버 15초 + 여유. 넘으면 서식 모드
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP_${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "TIMEOUT" : "NETWORK" };
  } finally { clearTimeout(t); }
}

export async function loadConfig() {
  const cached = store.sget(KEYS.config);
  if (cached) return cached;
  try { const c = await (await fetch("/api/config")).json(); store.sset(KEYS.config, c); return c; } catch { return { ai: {} }; }
}

/** Web Speech API (ko-KR). 미지원 브라우저면 null */
export function createSpeech({ onText, onState }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "ko-KR"; rec.interimResults = true; rec.maxAlternatives = 1;
  // 안드로이드 크롬은 continuous=true 에서 같은 문장을 결과마다 다시 보내 "아버지가 아버지가 …"처럼 쌓인다.
  // 그래서 (1) 매번 ev.results 전체를 처음부터 다시 조립하고(이어 붙이지 않음), (2) continuous=false 로 짧게 듣고
  // 세션이 끝나면 자동으로 다시 시작해 길게 말해도 끊기지 않게 한다. 세션마다 확정된 문장은 seed 에 모아 둔다.
  rec.continuous = false;
  let seed = "", sessionFinal = "", listening = false, restartTimer = null;
  rec.onresult = (ev) => {
    let fin = "", interim = "";
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) fin += r[0].transcript + " "; else interim += r[0].transcript;
    }
    sessionFinal = fin.trim();
    onText((seed + " " + sessionFinal).trim(), interim.trim());
  };
  rec.onend = () => {
    if (sessionFinal) seed = (seed + " " + sessionFinal).trim();
    sessionFinal = "";
    if (listening) { restartTimer = setTimeout(() => { try { rec.start(); } catch { listening = false; onState(false); } }, 150); } // 계속 듣기
    else onState(false);
  };
  rec.onerror = (e) => { if (e.error === "no-speech" || e.error === "aborted") return; listening = false; onState(false); };
  return {
    start(current = "") { seed = (current || "").trim(); sessionFinal = ""; try { rec.start(); listening = true; onState(true); } catch {} },
    stop() { listening = false; clearTimeout(restartTimer); try { rec.stop(); } catch {} onState(false); },
    get listening() { return listening; },
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return n;
}
// 오늘 날짜(이 기기의 시간대 기준, YYYY-MM-DD). 한국에서는 한국 날짜 — 서버 알림의 "오늘"과 같다
export const today = () => new Date().toLocaleDateString("sv-SE");

// ---------------------------------------------------------------- 일지 알림 (웹 푸시)
// 아이폰은 "홈 화면에 추가"한 앱에서만(iOS 16.4+), 안드로이드·PC 크롬은 브라우저에서도 된다.
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const b64uToBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
async function pushPost(body) { const r = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }
/** 지금 이 기기의 구독 (없으면 null) */
export async function currentPush() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
/** 알림 켜기: 권한 요청 → 구독 → 서버 저장. 반환 {ok, reason} */
export async function enablePush(lastDiaryDate) {
  if (!pushSupported()) return { ok: false, reason: "UNSUPPORTED" };
  const cfg = await (await fetch("/api/push")).json();
  if (!cfg.enabled) return { ok: false, reason: "SERVER_OFF" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "DENIED" };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.publicKey) });
  const out = await pushPost({ action: "subscribe", sub: sub.toJSON(), last: lastDiaryDate || null });
  return out.ok ? { ok: true } : { ok: false, reason: out.reason || "SAVE_FAILED" };
}
export async function disablePush() { const sub = await currentPush(); if (sub) { await pushPost({ action: "unsubscribe", endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); } }
export async function testPush() { const sub = await currentPush(); return sub ? pushPost({ action: "test", endpoint: sub.endpoint }) : { ok: false, reason: "NOT_SUBSCRIBED" }; }
/** 일지 저장 시: 오늘은 알림 보내지 않게 서버에 표시 (구독한 기기만) */
export async function markDiaryDone(date) { try { const sub = await currentPush(); if (sub) await pushPost({ action: "done", endpoint: sub.endpoint, date }); } catch {} }
export const fmtM = (m) => (typeof m !== "number" ? "거리 모름" : m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`);

/** 모의 응답이면 화면 상단에 표시 (실제 AI 결과로 오해하지 않도록) */
export function mockBanner(res) {
  if (!res?.mock) return;
  if ($("#mock-banner")) return;
  document.querySelector("main")?.prepend(el("div", { id: "mock-banner", class: "callout", style: "margin-bottom:10px" }, "⚠ 모의 응답(실제 AI 아님) — MOCK_AI=1 상태입니다. 시연 전에 끄세요."));
}

/** PWA 서비스워커 등록 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

/** 저녁 알림 카드(켜기·테스트·끄기)를 container 안에 그린다. 첫 화면·일지 화면에서 같이 쓴다 */
export function mountPushCard(container) {
  const REASONS = { UNSUPPORTED: "이 브라우저는 알림을 지원하지 않아요. 크롬이나 삼성 인터넷으로 열어 주세요.", SERVER_OFF: "알림 서버가 아직 준비되지 않았어요.", DENIED: "알림이 차단돼 있어요. 휴대폰 설정 → 이 앱(또는 브라우저) → 알림을 허용해 주세요.", NOT_SUBSCRIBED: "아직 알림이 켜져 있지 않아요." };
  const st = el("p", { class: "small", style: "margin:6px 0" });
  const on = el("button", { class: "btn-primary" }, "🔔 저녁 알림 켜기");
  const test = el("button", { class: "btn-secondary hidden" }, "테스트 알림");
  const off = el("button", { class: "btn-ghost hidden", style: "margin-top:6px" }, "알림 끄기");
  container.append(
    el("h3", { style: "margin-top:0" }, "🔔 일지 저녁 알림"),
    el("p", { class: "small muted", style: "margin-top:0" }, "매일 저녁 6시에 오늘 일지를 안 썼으면 알려 드려요. 그래도 안 쓰면 9시에 한 번 더. 쓴 날은 오지 않아요."),
    st, el("div", { class: "row" }, on, test), off);
  const diaryDates = () => store.get(KEYS.diary, []).map((x) => x.date);
  async function render() {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!pushSupported()) { st.textContent = isIOS && !isStandalone() ? "아이폰은 Safari 아래 공유 버튼 → '홈 화면에 추가' → 홈 화면의 아이콘으로 다시 열면 알림을 켤 수 있어요." : REASONS.UNSUPPORTED; on.disabled = true; return; }
    const sub = await currentPush().catch(() => null);
    const enabled = Boolean(sub) && Notification.permission === "granted";
    st.textContent = enabled ? "✅ 알림이 켜져 있어요." : Notification.permission === "denied" ? REASONS.DENIED : "알림이 꺼져 있어요.";
    on.classList.toggle("hidden", enabled); test.classList.toggle("hidden", !enabled); off.classList.toggle("hidden", !enabled);
  }
  on.onclick = async () => {
    on.disabled = true; st.textContent = "켜는 중…";
    const dates = diaryDates();
    const r = await enablePush(dates.sort().pop() || null).catch((e) => ({ ok: false, reason: String(e.message || e) }));
    on.disabled = false;
    if (!r.ok) { st.textContent = REASONS[r.reason] || `알림을 켜지 못했어요 (${r.reason})`; return; }
    if (diaryDates().includes(today())) markDiaryDone(today());
    render();
  };
  test.onclick = async () => { st.textContent = "테스트 알림 보내는 중…"; const r = await testPush().catch(() => ({ ok: false })); st.textContent = r.ok ? "테스트 알림을 보냈어요. 몇 초 안에 와야 해요." : REASONS[r.reason] || "테스트 알림을 보내지 못했어요."; };
  off.onclick = async () => { await disablePush().catch(() => {}); render(); };
  render();
}
