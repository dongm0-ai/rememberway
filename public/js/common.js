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
export const today = () => new Date().toISOString().slice(0, 10);
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
