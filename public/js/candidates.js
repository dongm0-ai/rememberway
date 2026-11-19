// REMEMBER WAY AI — 📍 예상 후보지 카드 (🚨 요약 화면·📍 실시간 위치 화면 공용)
// 계산은 코드(public/lib/predict.js), AI는 코드가 만든 후보 목록 안에서 순서·이유만 (/api/diary mode "candidates", 서버에서 verifyCandidates).
// AI가 안 되거나(실패·동의 안 함·빈 결과) 3곳을 못 채우면 코드 순서(fallbackOrder)로 채우고 이유도 코드 문장.
// AI에는 좌표·주소를 보내지 않는다(toAICandidate). 집은 후보가 아니다. 화면 글은 모두 textContent(el)로만 넣는다.
// 이 파일은 상대 경로만 import 한다(Node 테스트용). 네트워크·지도 검색 함수는 페이지가 deps 로 넘긴다.
import { lastMotion, projectPath, reachM, candidateFeatures, fallbackOrder, motionSummary, direction8, DIRECTIONS_8 } from "../lib/predict.js";
import { fmtDist, fmtElapsed } from "../lib/verify.js";
import { WALK_SPEED, BASIC_KINDS, addressLike } from "../lib/schema.js";
import { distM } from "../lib/gps.js";
import { icon } from "./icons.js";

const num = (v) => typeof v === "number" && Number.isFinite(v);
const hasCoord = (p) => !!p && num(p.lat) && num(p.lng) && !(p.lat === 0 && p.lng === 0);
export const MAX_AI = 15;          // 서버가 받는 최대 후보 수
export const HOME_M = 100;
export const LIVE_MS = 150000;     // 움직이는 동안 목걸이는 10초마다 보낸다(멈춤 판정 3분) — 마지막 위치가 2분 30초 안이면 "이동 중"         // 집에서 이 안이면 후보에서 뺀다
const SAME_M = 60;                 // 이미 있는 후보와 이 안이면 같은 곳으로 보고 뺀다
const LIMITS = { memory: 8, frequent: 4 };

/** 출처 배지 글 */
export function sourceBadge(source) {
  if (source === "memory") return "추억의 장소";
  if (source === "frequent" || source === "rising") return "자주 머문 곳";
  if (source === "basic") return "기본 장소";
  return "보호자가 말한 곳";
}

/** /api/loc latest 점 → 오늘(이 기기 날짜) 점만 {t, lat, lng, speed_kmh} */
export function pointsToday(points, nowMs) {
  const day = (ms) => new Date(ms).toLocaleDateString("sv-SE");
  const today = day(nowMs);
  return (Array.isArray(points) ? points : []).map((p) => ({ t: Date.parse(p?.gps_time || p?.received_at || ""), lat: p?.lat, lng: p?.lng, speed_kmh: num(p?.speed_kmh) ? p.speed_kmh : undefined }))
    .filter((p) => num(p.t) && hasCoord(p) && p.t <= nowMs + 5 * 60000 && day(p.t) === today);
}

/** "북동쪽", "남 방향" → 방위각(°). 방향 말만 받는다(동네 이름 "석교동"은 아님). 모르면 null */
export function parseDirection(text) {
  const m = String(text ?? "").trim().match(/^(북동|북서|남동|남서|북|남|동|서)\s*(쪽|방향|으로|쪽으로)?\s*$/);
  return m ? DIRECTIONS_8.indexOf(m[1]) * 45 : null;
}

/** a → b 처음 방위각(0~360) */
export function bearingDeg(a, b) {
  const r = (x) => (x * Math.PI) / 180, f1 = r(a.lat), f2 = r(b.lat), dl = r(b.lng - a.lng);
  return ((Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
}

/**
 * GPS가 없을 때 보호자 단서로 motion 만들기. 출발점 = 집(이 기기 저장 좌표), 나간 시각 = 신고 시각 − 경과 시간.
 * 방향: clue.direction → 없으면 오늘 가려던 곳(dest 좌표) 쪽 → 둘 다 없으면 state "none"(거리 순).
 * @returns motion(+fromClue, dirFrom) | null(집 좌표 없음)
 */
export function motionFromClue(clue, mode, home, nowMs, dest = null) {
  if (!hasCoord(home) || !num(nowMs)) return null;
  const elapsed = num(mode?.elapsedMin) && mode.elapsedMin >= 0 ? mode.elapsedMin : 60;
  const at = Date.parse(mode?.started_at ?? "");
  const t = (num(at) ? at : nowMs) - elapsed * 60000;
  const base = { lat: home.lat, lng: home.lng, t, fromClue: true };
  const said = parseDirection(clue?.direction);
  const brg = said ?? (hasCoord(dest) && distM(home, dest) > HOME_M ? bearingDeg(home, dest) : null);
  if (brg === null) return { ...base, state: "none" };
  return { ...base, state: "moving_lost", speedMps: WALK_SPEED[mode?.gait] ?? WALK_SPEED.normal, bearingDeg: brg, dirFrom: said !== null ? "direction" : "destination" };
}

/** 근거 문장에서 주소·좌표처럼 보이는 것은 AI에 보내지 않는다 */
export function safeEvidence(s) {
  const v = typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
  if (!v || /\d+\s*(번길|길|로)\s*\d|\d+-\d+|번지|\d+\.\d{3,}|좌표|주소/.test(v)) return null;
  return v.slice(0, 80);
}
const cleanName = (s) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
const isHomeName = (s) => /^(집|우리\s*집|자택|어르신\s*집|본가)$/.test(cleanName(s));

/**
 * 후보 장소 모으기(좌표가 있는 것만): 추억·등록 장소 → 자주 머문 곳 → 기본 장소. 집 근처·같은 이름·거의 같은 자리는 뺀다.
 * @param {{memory?:object[], frequent?:object[], basic?:object[], home?:{lat,lng}|null}} g
 * @returns {{id,name,source,evidence,lat,lng}[]}
 */
export function buildPlaces({ memory = [], frequent = [], basic = [], home = null } = {}) {
  const out = [], names = new Set();
  const nearHome = (p) => hasCoord(home) && distM(home, p) <= HOME_M;
  const dup = (p) => out.some((q) => distM(q, p) <= SAME_M);
  const add = (p) => { if (!hasCoord(p) || nearHome(p) || !p.name || names.has(p.name) || isHomeName(p.name) || dup(p)) return false; names.add(p.name); out.push(p); return true; };
  let k = 0;
  for (const p of memory) {
    if (k >= LIMITS.memory) break;
    const src = ["memory", "frequent", "rising", "new", "guardian"].includes(p?.source) ? (p.source === "rising" ? "frequent" : p.source) : "guardian";
    if (add({ id: `m${k + 1}`, name: cleanName(p?.name), source: src, evidence: safeEvidence(p?.evidence), lat: p?.lat, lng: p?.lng })) k++;
  }
  k = 0;
  for (const p of frequent) {
    if (k >= LIMITS.frequent || p?.home) continue;
    const days = Array.isArray(p?.days) ? p.days.length : null;
    const ev = days ? `최근 30일 중 ${days}일 머무심${p.hour_band ? `, 주로 ${p.hour_band}` : ""}` : "GPS 기록에서 자주 머문 곳";
    if (add({ id: `f${k + 1}`, name: `자주 머문 곳 ${k + 1}`, source: "frequent", evidence: safeEvidence(ev), lat: p?.lat, lng: p?.lng })) k++;
  }
  k = 0;
  for (const p of basic) {
    const kind = cleanName(p?.kindOf), nm = cleanName(p?.found_name ?? p?.name);
    if (add({ id: `b${k + 1}`, name: cleanName(kind && nm && !nm.startsWith(kind) ? `${kind}: ${nm}` : nm || kind), source: "basic", evidence: kind ? `예상 경로 끝 근처 ${kind}` : null, lat: p?.lat, lng: p?.lng })) k++;
  }
  return out;
}

/** 이름이 주소·좌표처럼 보이는지 (보호자가 "대종로 12번길 3"처럼 적은 경우) — 규칙은 lib/schema.js 하나 (family.js 업로드 정리와 같이 씀) */
export { addressLike };
/** AI에 보낼 모양 — 좌표·주소 없음. 주소처럼 보이는 이름은 "추억의 장소 N" 같은 이름으로 바꿔 보낸다(화면에는 원래 이름) */
export function toAICandidate(f) {
  const n = String(f.id ?? "").replace(/\D/g, "") || "1";
  const c = { id: f.id, name: addressLike(f.name) ? `${sourceBadge(f.source)} ${n}` : f.name, source: f.source, dist_m: f.dist_m, bearing_diff_deg: f.bearing_diff_deg, reachable: f.reachable, path_dist_m: f.path_dist_m };
  if (f.evidence) c.evidence = f.evidence;
  return c;
}
/** AI에 보낼 후보: 코드 순서 앞에서 최대 15개 */
export const forAI = (features) => fallbackOrder(features).slice(0, MAX_AI);

/** 코드가 만드는 이유 문장 (AI를 못 쓸 때·빈 칸 채울 때). 숫자는 fmtDist 그대로 */
export function codeReason(f, motion) {
  const parts = [];
  const d = fmtDist(f.dist_m);
  if (num(f.bearing_diff_deg)) {
    const a = f.bearing_diff_deg;
    parts.push(`${a <= 30 ? "가던 방향" : a <= 75 ? "가던 방향에서 조금 비낀 쪽" : a <= 120 ? "가던 방향 옆쪽" : "가던 방향 반대쪽"} ${d}`);
  } else parts.push(`${motion?.fromClue ? "집" : "마지막 위치"}에서 ${d}`);
  if (num(f.path_dist_m) && f.path_dist_m <= 200) parts.push("예상 경로 바로 옆");
  parts.push(f.reachable ? "지금 걸어서 닿을 수 있음" : "걸어서 닿기엔 아직 멂");
  return parts.join(", ");
}

/**
 * AI 순서 + 코드 순서로 3곳 채우기. 목록 밖 id·중복은 버린다(서버도 버리지만 한 번 더).
 * @returns {Array<object>} feature + {reason, warn, by:"ai"|"code"}
 */
export function mergeRanked(ranked, features, motion, n = 3) {
  const byId = new Map((features ?? []).map((f) => [f.id, f])), used = new Set(), out = [];
  for (const r of Array.isArray(ranked) ? ranked : []) {
    const f = byId.get(r?.id);
    if (!f || used.has(f.id) || out.length >= n || typeof r.reason !== "string" || !r.reason.trim()) continue;
    used.add(f.id); out.push({ ...f, reason: r.reason.trim(), warn: r.warn === true, by: "ai" });
  }
  for (const f of fallbackOrder(features)) {
    if (out.length >= n) break;
    if (used.has(f.id)) continue;
    used.add(f.id); out.push({ ...f, reason: codeReason(f, motion), warn: false, by: "code" });
  }
  return out;
}

/** 이 기기 시각 HH:MM */
export const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** 카드 부제: "14:05 북동쪽 시속 3km 이후 끊김, 40분 지남" 등 */
export function headline(motion, nowMs) {
  const s = motionSummary(motion, nowMs);
  const el = fmtElapsed(num(motion?.t) && num(nowMs) ? Math.max(0, Math.round((nowMs - motion.t) / 60000)) : null);
  const at = num(motion?.t) ? hhmm(motion.t) : null;
  const ago = el ? `${el} 지남` : "";
  if (motion?.fromClue) {
    const left = at ? `${at}쯤 집에서 나가심` : "집에서 나가심";
    if (motion.state === "moving_lost") {
      const dir = direction8(motion.bearingDeg);
      return motion.dirFrom === "destination"
        ? `보호자 말: ${left}, 가려던 곳 쪽(${dir}쪽)으로 걸으셨다고 보고 계산${ago ? `, ${ago}` : ""}`
        : `보호자 말: ${left}, ${dir}쪽으로 걸으셨다고 보고 계산${ago ? `, ${ago}` : ""}`;
    }
    return `보호자 말: ${left}${ago ? `, ${ago}` : ""} · 방향을 몰라 집에서 가까운 순`;
  }
  if (s.state === "moving_lost") return `${at} ${s.direction_8}쪽 시속 ${Math.round(s.speed_kmh)}km 이후 끊김${ago ? `, ${ago}` : ""}`;
  if (s.state === "stayed") return `${at}부터 그 자리에 머무시는 중일 수 있어요${ago ? ` (${ago})` : ""} · 마지막 위치에서 가까운 순`;
  return "";
}

/**
 * 후보지 계산 전체 흐름 (지도 그리기·화면 붙이기는 페이지가).
 * deps: { points(오늘 GPS, pointsToday 결과), clue, mode, home, profile, elderId, nowMs,
 *         authFetch, api, findPlaceLoose, findNearby, geoCache?: Map }
 *         aiCache?: Map — AI 순서를 (마지막 위치·후보 id 묶음)별로 기억. 시간만 지난 재계산은 AI를 다시 부르지 않는다
 * → { status:"ok"|"empty"|"nodata"|"live", motion, path, reach, top, ai:boolean, aiReason, mock }
 * live: 아직 움직이며 위치가 오는 중(마지막 위치가 LIVE_MS 안) — 예상 후보지를 만들지 않는다(AI·검색 없음)
 */
export async function computeCandidates(deps) {
  const { points = [], clue = null, mode = null, home = null, profile = null, elderId = null, nowMs = Date.now(), authFetch, api, findPlaceLoose, findNearby } = deps;
  const cache = deps.geoCache ?? new Map();
  const geo = async (name, near) => {
    if (cache.has(name)) return cache.get(name);
    let f = null; try { f = findPlaceLoose ? await findPlaceLoose(name, near) : null; } catch {}
    const v = hasCoord(f) ? { lat: f.lat, lng: f.lng } : null; cache.set(name, v); return v;
  };
  let motion = lastMotion(points);
  if (motion.state === "moving_lost" && nowMs - motion.t < LIVE_MS) return { status: "live", motion };
  if (motion.state === "none") {
    if (!clue || !hasCoord(home)) return { status: "nodata" };
    const dest = clue.today_destination && parseDirection(clue.direction) === null ? await geo(String(clue.today_destination), home) : null;
    motion = motionFromClue(clue, mode, home, nowMs, dest);
    if (!motion) return { status: "nodata" };
  }
  const path = projectPath(motion, nowMs), reach = reachM(motion, nowMs);
  const end = path.length ? path[path.length - 1] : motion;
  const near = hasCoord(home) ? home : motion;

  // 1) 추억·등록 장소 (프로필 + 이번 단서의 장소). 좌표 없으면 지도 검색
  const seen = new Set(), named = [];
  for (const p of [...(profile?.places ?? []), ...(clue?.memory_places ?? [])]) {
    const nm = cleanName(p?.name); if (!nm || seen.has(nm) || isHomeName(nm)) continue;
    seen.add(nm); named.push(p);
    if (named.length >= LIMITS.memory + 4) break;
  }
  const memoryP = Promise.all(named.map(async (p) => (hasCoord(p) ? p : { ...p, ...(await geo(cleanName(p.name), near)) })));
  // 2) 자주 머문 곳 (서버 30일 기록)
  const freqP = elderId && authFetch ? authFetch({ action: "places", elderId }).then((r) => (r?.ok && Array.isArray(r.places) ? r.places : [])).catch(() => []) : Promise.resolve([]);
  // 3) 예상 경로 끝(또는 마지막 위치) 근처 기본 장소, 반경 500m
  const basicP = findNearby ? Promise.all(BASIC_KINDS.map((kind) => findNearby(kind, end, 500, 1).then((a) => (a ?? []).map((x) => ({ ...x, kindOf: kind }))).catch(() => []))).then((a) => a.flat()) : Promise.resolve([]);
  const [memory, frequent, basic] = await Promise.all([memoryP, freqP, basicP]);

  const places = buildPlaces({ memory, frequent, basic, home });
  const features = candidateFeatures(motion, nowMs, places);
  if (!features.length) return { status: "empty", motion, path, reach, top: [] };
  const sent = forAI(features);
  // AI 순서는 마지막 위치와 후보 묶음이 같으면 다시 쓰고(성공한 답만 기억), 바뀌었을 때만 다시 묻는다
  const aiCache = deps.aiCache, aiKey = /* id+이름: 다른 곳이 같은 id(b1)를 받을 수 있어 이름까지 */ `${motion.state}|${motion.t}|${sent.map((c) => `${c.id}=${c.name}`).sort().join(",")}`;
  let res = aiCache?.get(aiKey) ?? null;
  if (!res) {
    res = { ok: false, reason: "NO_API" };
    if (api) {
      try {
        res = await api("diary", { mode: "candidates", honorific: profile?.honorific || clue?.honorific || "어르신", motion: motionSummary(motion, nowMs), candidates: sent.map(toAICandidate) });
      } catch { res = { ok: false, reason: "NETWORK" }; }
    }
    if (res?.ok && aiCache) { aiCache.clear(); aiCache.set(aiKey, res); }
  }
  const ranked = res?.ok && Array.isArray(res.ranked) ? res.ranked : [];
  const top = mergeRanked(ranked, sent, motion);
  return { status: "ok", motion, path, reach, top, ai: top.some((c) => c.by === "ai"), aiReason: res?.ok ? (ranked.length ? null : "EMPTY") : res?.reason ?? "ERROR", mock: !!res?.mock };
}

/** 아직 움직이는 중일 때 한 줄 */
export function liveLine(motion, nowMs) {
  const s = motionSummary(motion, nowMs), sec = Math.max(0, Math.round((nowMs - motion.t) / 1000));
  return `지금 ${s.direction_8}쪽으로 시속 ${Math.round(s.speed_kmh)}km로 이동 중이세요 (마지막 위치 ${sec}초 전). 위치가 끊기면 예상 후보지를 계산해요.`;
}
/** 10초 갱신 때: 네트워크 없이 부제(경과 시간)만 새 시각으로 고친다 */
export function refreshHeadline(box, result, nowMs) {
  const p = box?.querySelector?.(".cand-sub");
  if (!p || !result?.motion) return false;
  p.textContent = result.status === "live" ? liveLine(result.motion, nowMs) : headline(result.motion, nowMs);
  return true;
}
/** 카드 그리기. box 안을 비우고 다시 채운다. el = common.js 의 el (글은 textContent 로만 들어간다) */
export function renderCandidates(box, result, { el, nowMs = Date.now(), loading = false, message = "" } = {}) {
  box.replaceChildren();
  const card = el("div", { class: "card", id: "cand-card" }, el("h2", { style: "margin:0 0 4px" }, "예상 후보지"));
  box.append(card);
  if (result?.status === "live" && !loading && !message) { card.append(el("p", { class: "cand-sub", style: "margin:0;font-size:18px" }, liveLine(result.motion, nowMs))); return; }
  if (loading || message || !result || result.status !== "ok") {
    const text = loading ? "예상 경로와 후보지를 계산하는 중…" : message
      || (result?.status === "empty" ? "근처에서 후보로 볼 만한 곳을 찾지 못했어요. 지도의 점선(예상 경로)과 원(걸어서 닿는 범위)을 참고해 주세요."
        : "오늘 받은 GPS 위치도, 집 위치도 없어 예상 후보지를 만들 수 없어요.");
    if (result?.status === "empty" && result.motion) card.append(el("p", { class: "small cand-sub", style: "margin:0 0 6px" }, headline(result.motion, nowMs)));
    card.append(el("p", { class: "muted", style: "margin:0" }, text));
    return;
  }
  const { motion, top } = result;
  card.append(el("p", { class: "small cand-sub", style: "margin:0 0 8px;font-weight:700" }, headline(motion, nowMs)));
  const ol = el("ol", { class: "rank", id: "cand-list" });
  const origin = motion.fromClue ? "집" : "마지막 위치";
  top.forEach((c, i) => {
    const dir = direction8(bearingDeg(motion, c));
    const chips = el("div", { class: "chips", style: "gap:6px;margin:4px 0" },
      el("span", { class: "badge src", style: "margin-left:0" }, `${origin}에서 ${fmtDist(c.dist_m)}`),
      dir && c.dist_m > 0 ? el("span", { class: "badge src", style: "margin-left:0" }, `${dir}쪽`) : "",
      el("span", { class: `badge ${c.reachable ? "ok" : "src"}`, style: "margin-left:0" }, c.reachable ? "걸어서 닿을 수 있음" : "걸어서 닿기엔 멂"));
    const nav = el("a", { class: "small", style: "display:inline-block;min-height:48px;line-height:48px;padding:0 4px", href: `https://map.naver.com/p/directions/-/${c.lng},${c.lat},${encodeURIComponent(c.name)}/-/walk`, target: "_blank", rel: "noopener" }, "길찾기");
    ol.append(el("li", { "data-id": c.id },
      el("span", { class: "n", style: "background:#7b3fe4;color:#fff;border-radius:8px" }, i + 1),
      el("div", {},
        el("div", { class: "nm", style: "font-size:18px;font-weight:800" }, c.name, el("span", { class: "badge src" }, sourceBadge(c.source))),
        chips,
        el("div", { class: "reason", style: "font-size:18px;line-height:1.5" }, c.reason,
          c.warn ? el("span", { class: "badge warn", title: "이유에 나온 숫자가 계산값과 맞지 않아요" }, icon("alert"), " 숫자 확인") : "")),
      el("div", { class: "acts" }, nav)));
  });
  card.append(ol);
  const how = result.ai
    ? (top.some((c) => c.by === "code") ? "순서·이유: AI(코드가 만든 후보 안에서) + 나머지는 코드 계산 순서." : "순서·이유: AI가 코드가 만든 후보 안에서만 골랐어요.")
    : `${result.aiReason === "NO_CONSENT" ? "AI 사용에 동의하지 않으셔서" : "AI를 쓸 수 없어"} 코드 계산(걸어서 닿는지·예상 경로까지 거리) 순서로 보여 드려요.`;
  card.append(el("p", { class: "small muted", id: "cand-how", style: "margin:8px 0 0" }, how),
    el("p", { class: "small muted", style: "margin:4px 0 0" }, motion.state === "moving_lost"
      ? "예상일 뿐이에요. 지도의 보라색 점선은 같은 방향·속도로 계속 걸으셨다고 가정한 길, 원은 지금까지 걸어서 닿을 수 있는 범위, 보라색 1·2·3은 위 후보예요."
      : "예상일 뿐이에요. 지도의 보라색 원은 지금까지 걸어서 닿을 수 있는 범위, 보라색 1·2·3은 위 후보예요."));
}
