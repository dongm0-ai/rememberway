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
// 생성형 AI를 부르는 서버 함수들. 처음 한 번 "보호자의 말이 AI 회사로 전달된다"는 동의를 받는다 (이 기기에 기억)
const AI_ENDPOINTS = new Set(["extract", "followup", "diary", "weekly", "record"]);
const CONSENT_KEY = "rw_ai_consent";
export const aiConsented = () => { try { return Boolean(localStorage.getItem(CONSENT_KEY)); } catch { return false; } };
/** 동의 창. 동의 → true(기억), "AI 없이" → false(이번 방문 동안 다시 묻지 않음, 서식 입력으로) */
export function askAiConsent() {
  if (aiConsented()) return Promise.resolve(true);
  if (store.sget("rw_ai_decline")) return Promise.resolve(false);
  return new Promise((resolve) => {
    const dlg = el("dialog", { "aria-labelledby": "consent-title" },
      el("h2", { id: "consent-title", style: "margin-top:0" }, "AI 정리 전에 확인해 주세요"),
      el("ul", { class: "plain small" },
        el("li", {}, "보호자가 말하거나 쓴 내용과 등록 정보가 정리를 위해 ", el("b", {}, "AI 회사(Upstage, 장애 시 Google)"), "로 전달됩니다."),
        el("li", {}, "이 앱의 서버는 그 내용을 저장하지 않습니다. 이름은 묻지 않으니 이름·전화번호는 말하지 말아 주세요."),
        el("li", {}, "동의하지 않아도 ", el("b", {}, "정해진 질문(서식)"), "으로 똑같이 요약을 만들 수 있습니다.")),
      el("div", { class: "stack", style: "margin-top:14px" },
        el("button", { class: "btn-primary", onclick: () => { try { localStorage.setItem(CONSENT_KEY, new Date().toISOString().slice(0, 10)); } catch {} done(true); } }, "동의하고 AI로 정리"),
        el("button", { class: "btn-secondary", onclick: () => { store.sset("rw_ai_decline", 1); done(false); } }, "AI 없이 서식으로")));
    function done(v) { dlg.close(); dlg.remove(); resolve(v); }
    dlg.addEventListener("cancel", (e) => e.preventDefault()); // 둘 중 하나는 고르게
    document.body.append(dlg); dlg.showModal();
  });
}
export function resetAiConsent() { try { localStorage.removeItem(CONSENT_KEY); } catch {} try { sessionStorage.removeItem("rw_ai_decline"); } catch {} }

export async function api(name, body, timeoutMs = 16000) { // 서버 15초 + 여유. 넘으면 서식 모드
  if (AI_ENDPOINTS.has(name) && !(await askAiConsent())) return { ok: false, reason: "NO_CONSENT" }; // 동의 안 하면 AI 장애 때와 같은 서식 모드
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

/** 화면에 보일 생성형 AI 이름: "Upstage Solar (solar-pro4)" */
export function aiName(ai = {}) {
  const p = { upstage: "Upstage Solar", gemini: "Google Gemini", claude: "Anthropic Claude" }[ai.provider || ai.active];
  return p ? `${p}${ai.model ? ` · ${ai.model}` : ""}` : "";
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

// ---------------------------------------------------------------- 어르신 집 주소 (배민처럼 처음에 한 번 설정 → 이 기기에 저장)
// 2026-11-03: 도로명·지번·건물명까지 받는다(동·호수는 받지 않음). 저장: localStorage "rw_home" =
//   { label: "대전광역시 중구 석교동"(행정동, 검색어·요약용), road, jibun, building, lat, lng, savedAt } — 브라우저 사이트 데이터를 지우기 전까지 남는다.
// 집 주소는 이 기기에만 저장하고 서버에 남기지 않는다. 경찰 요약·공유 글에는 동까지만 (주소 상세는 보호자가 112에 직접).
const HOME_KEY = "rw_home";
export function getHome() { const h = store.get(HOME_KEY, null); return h && h.label && Number.isFinite(h.lat) ? h : null; }
export function saveHome(h) { const v = { label: String(h.label ?? "").trim(), road: h.road || null, jibun: h.jibun || null, building: h.building || null, lat: Number(h.lat), lng: Number(h.lng), savedAt: new Date().toLocaleDateString("sv-SE") }; store.set(HOME_KEY, v); return v; }
export function clearHome() { store.del(HOME_KEY); store.del("rw_last_home"); }
/** 화면에 보일 짧은 집 이름: 건물명 > 도로명 > 동 */
export const homeShort = (h) => (h ? (h.building ? `${h.building}` : h.road || h.jibun || h.label) : "");

/** 집 주소 설정 카드. onDone(home) 은 저장 직후 불린다 */
export function homeSetup(onDone, opts = {}) {
  const box = el("div", { class: "home-setup" });
  const msg = el("p", { class: "small muted", style: "margin:8px 0 0" });
  const result = el("div", { class: "home-result hidden" });
  const inp = el("input", { type: "text", id: "home-q", placeholder: "도로명, 지번, 건물명 (예: 대종로 228)", autocomplete: "off" });
  const done = (h) => { const saved = saveHome(h); onDone?.(saved); };
  const card = (it) => el("button", { class: "home-pick", onclick: () => done(it) },
    el("b", {}, it.building && it.building !== it.road ? it.building : it.road || it.jibun || it.label),
    it.road ? el("span", { class: "small" }, el("span", { class: "addr-tag" }, "도로명"), it.road) : "",
    it.jibun ? el("span", { class: "small" }, el("span", { class: "addr-tag" }, "지번"), it.jibun) : "",
    it.dongOnly ? el("span", { class: "small muted" }, "동까지만 (건물을 찾으면 더 정확해요)") : "");
  const here = el("button", { class: "btn-secondary", onclick: () => {
    if (!navigator.geolocation) { msg.textContent = "이 브라우저는 위치를 지원하지 않아요. 주소로 검색해 주세요."; return; }
    msg.textContent = "현재 위치를 찾는 중… (권한을 물으면 '허용')";
    navigator.geolocation.getCurrentPosition(async (p) => {
      const lat = p.coords.latitude, lng = p.coords.longitude;
      try {
        const d = await (await fetch(`/api/geocode?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`)).json(); msg.textContent = "";
        result.innerHTML = ""; result.classList.remove("hidden");
        if (d.ok && d.label) result.append(el("div", { class: "small muted" }, "지금 계신 곳이 맞나요?"), card({ ...d, lat, lng }));
        else { msg.textContent = "주소를 찾지 못했어요. 도로명이나 건물명으로 검색해 주세요."; result.classList.add("hidden"); }
      } catch { msg.textContent = "인터넷 연결을 확인해 주세요."; }
    }, (e) => { msg.textContent = e.code === 1 ? "위치 권한이 꺼져 있어요. 주소로 검색해 주세요." : "위치를 찾지 못했어요. 주소로 검색해 주세요."; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  } }, "📍 현재 위치로 설정 (지금 집이면)");
  const search = async () => {
    const q = inp.value.trim(); if (!q) return inp.focus();
    msg.textContent = "찾는 중…"; result.classList.add("hidden");
    try {
      const d = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}&list=1`)).json(); msg.textContent = "";
      const items = d.ok ? d.items : [];
      if (!items.length) { msg.textContent = "찾지 못했어요. 시·구를 붙이거나 도로명+건물번호로 적어 보세요 (예: 대전 중구 대종로 228)."; return; }
      result.innerHTML = ""; result.classList.remove("hidden");
      result.append(el("div", { class: "small muted" }, "집 주소를 골라 주세요"), ...items.map(card));
    } catch { msg.textContent = "인터넷 연결을 확인해 주세요."; }
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  box.append(
    el("h2", { style: "margin:0 0 4px" }, opts.title ?? "어르신 집 주소를 설정해 주세요"),
    el("p", { class: "small muted", style: "margin:0 0 12px" }, "실종됐을 때 지도와 걷는 길의 출발점이 돼요. 한 번 설정하면 이 기기에 남아 있어요."),
    here,
    el("div", { class: "row", style: "margin-top:10px" }, inp, el("button", { class: "btn-secondary", style: "flex:0 0 auto;width:auto", onclick: search }, "검색")),
    msg, result,
    el("p", { class: "small muted", style: "margin:10px 0 0" }, "아파트 동·호수는 적지 않아도 돼요. 주소는 이 기기에만 저장되고(서버에 남지 않음), 인터넷 사용 기록을 지우면 사라집니다. 경찰 요약·공유 글에는 동까지만 들어가요."));
  return box;
}

/** "📍 석교동 행정복지센터 ▾" — 누르면 집 주소 설정 카드를 dialog로 연다. onChange(home) */
export function homeChip(onChange) {
  const h = getHome();
  const chip = el("button", { class: "home-chip", "aria-label": "어르신 집 주소 바꾸기", title: h ? [h.road, h.jibun].filter(Boolean).join(" / ") : "" }, `📍 ${h ? homeShort(h) : "집 주소 설정"}`, el("span", { "aria-hidden": "true" }, " ▾"));
  chip.onclick = () => {
    const dlg = el("dialog", {});
    dlg.append(homeSetup((nh) => { dlg.close(); dlg.remove(); chip.firstChild.textContent = `📍 ${homeShort(nh)}`; onChange?.(nh); }, { title: "어르신 집 주소" }),
      el("button", { class: "btn-ghost small", style: "margin-top:6px", onclick: () => { dlg.close(); dlg.remove(); } }, "닫기"));
    document.body.append(dlg); dlg.showModal();
  };
  return chip;
}
