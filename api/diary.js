// POST /api/diary — 호출 ⑤ 일지 발화 → new_places / mentions / notes
//                  호출 ⑦ (mode:"gps") GPS 자주 머문 곳 → 보호자 되묻기 질문 + 정리 문장 (Vercel 함수 12개 한도로 이 파일에 합침)
//                  호출 ⑧ (mode:"memory") 기억 꺼내기 대화: 보호자의 답 → 장소 이름 + 후속 질문 1개. body: { mode, honorific, topic, question, answer, knownPlaces }
//                  호출 ⑨ (mode:"candidates") 예상 후보지: 코드가 만든 후보 목록 안에서 AI가 순서·이유만. 좌표는 받아도 쓰지 않는다.
//                    body: { mode, honorific, motion:{state, minutes_since, speed_kmh, direction_8}, candidates:[{id, name, source, evidence, dist_m, bearing_diff_deg, reachable, path_dist_m}] } (최대 15개)
// 칩만 탭한 날은 이 라우트를 부르지 않는다. "다른 곳이 있어요"로 말했을 때만.
// body: { spoken: string, knownPlaces: string[], date: string }
import { askJSON } from "../lib/claude.js";
import { SYSTEM_DIARY, userDiary, SYSTEM_GPS, userGps, SYSTEM_MEMORY, userMemory, SYSTEM_CANDIDATES, userCandidates } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { appearsInSource, verifyMemory, verifyCandidates } from "../public/lib/verify.js";
import { MEMORY_TOPICS } from "../public/lib/schema.js";
import { DIRECTIONS_8 } from "../public/lib/predict.js";

const BANNED = /(위험|예측|확률|실종 가능성|AI가 추천)/; // mode "gps" 전용
const BANNED_CANDIDATES = /(확률|%|AI가 추천)/;          // mode "candidates" 전용

// 호출 ⑦ 검증(코드): id 일치, 질문에 장소 label 포함, 금지어·입력에 없는 숫자가 있으면 그 질문은 버림 → 화면이 기본 질문(templateQuestion)을 씀
async function gpsQuestions({ honorific, track, places }) {
  if (!Array.isArray(places) || !places.length || places.length > 30) return { ok: false, reason: "BAD_INPUT" };
  const clean = places.map((p) => ({ id: String(p.id).slice(0, 8), label: String(p.label ?? "").slice(0, 30), days_n: Number(p.days_n) || 0, avg_min: Number(p.avg_min) || 0, weekdays: (p.weekdays ?? []).slice(0, 2).map(String), hour_band: p.hour_band ? String(p.hour_band).slice(0, 12) : null }));
  const tr = { days: Number(track?.days) || 0, period_days: Number(track?.period_days) || 0 };
  const raw = await askJSON(SYSTEM_GPS, userGps(String(honorific ?? "어르신").slice(0, 10), tr, clean), { maxTokens: 1200 });
  const nums = new Set(JSON.stringify({ tr, clean }).match(/\d+/g) ?? []);
  const numsOk = (t) => (t.match(/\d+/g) ?? []).every((n) => nums.has(n));
  const questions = (raw?.questions ?? []).map((q) => {
    const p = clean.find((x) => x.id === q?.id), t = String(q?.question ?? "").trim();
    return p && t && t.length <= 160 && !BANNED.test(t) && numsOk(t) && t.includes(p.label.replace(/ 어딘가$/, "")) ? { id: p.id, question: t } : null;
  }).filter(Boolean);
  const summary = String(raw?.summary ?? "").split(/(?<=[.다요])\s+/).filter((x) => x && !BANNED.test(x) && numsOk(x)).join(" ").trim() || null;
  return { ok: true, summary, questions, dropped: clean.length - questions.length };
}

// 호출 ⑧ 검증(코드): 답에 없는 장소·이미 아는 장소는 버리고, 후속 질문은 160자 이하 질문 1개만 남김 (public/lib/verify.js verifyMemory)
async function memoryPlaces({ honorific, topic, question, answer, knownPlaces }) {
  const t = MEMORY_TOPICS.find((x) => x.key === topic);
  if (!t || typeof answer !== "string" || !answer.trim() || answer.length > 1000) return { ok: false, reason: "BAD_INPUT" };
  const known = (Array.isArray(knownPlaces) ? knownPlaces : []).map((k) => String(k).slice(0, 40)).slice(0, 200);
  const q = String(question ?? "").slice(0, 200);
  const raw = await askJSON(SYSTEM_MEMORY, userMemory(String(honorific ?? "어르신").slice(0, 10), t.label, q, answer, known), { maxTokens: 700 });
  return { ok: true, ...verifyMemory(raw, answer, known, q) };
}

// 호출 ⑨ 입력 정리(코드): 필요한 칸만 새 객체로 옮겨 담는다 → 좌표·주소·원문 같은 다른 칸은 AI에 가지 않는다. 모양이 틀리면 null
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const SOURCES = ["memory", "frequent", "rising", "new", "guardian", "basic"];
function cleanMotion(m) {
  if (!m || typeof m !== "object" || !["moving_lost", "stayed", "none"].includes(m.state)) return null;
  const opt = (v, max, scale = 1) => (v == null ? null : fin(v) && v >= 0 && v <= max ? Math.round(v * scale) / scale : undefined);
  const minutes = opt(m.minutes_since, 525600), speed = opt(m.speed_kmh, 200, 10);
  const dir = m.direction_8 == null ? null : DIRECTIONS_8.includes(m.direction_8) ? m.direction_8 : undefined;
  if (minutes === undefined || speed === undefined || dir === undefined) return null;
  const moving = m.state === "moving_lost"; // 움직임이 아니면 속도·방향은 의미가 없다
  return { state: m.state, minutes_since: minutes, speed_kmh: moving ? speed : null, direction_8: moving ? dir : null };
}
function cleanCandidate(c) {
  if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.name !== "string") return null;
  const id = c.id.trim().slice(0, 40), name = c.name.trim().replace(/\s+/g, " ").slice(0, 40);
  const opt = (v, max) => (v == null ? null : fin(v) && v >= 0 && v <= max ? Math.round(v) : undefined);
  const dist = fin(c.dist_m) && c.dist_m >= 0 ? Math.round(c.dist_m) : undefined, diff = opt(c.bearing_diff_deg, 180), path = opt(c.path_dist_m, Infinity);
  if (!id || !name || dist === undefined || diff === undefined || path === undefined || typeof c.reachable !== "boolean") return null;
  const evidence = typeof c.evidence === "string" && c.evidence.trim() ? c.evidence.trim().slice(0, 80) : null;
  return { id, name, source: SOURCES.includes(c.source) ? c.source : "guardian", evidence, dist_m: dist, bearing_diff_deg: diff, reachable: c.reachable, path_dist_m: path };
}

// 호출 ⑨ 검증(코드): 목록 밖 id·중복은 버리고 최대 3개, 이유는 200자 이하·금지어 없음, 이유의 숫자가 입력에 없으면 warn:true (public/lib/verify.js verifyCandidates).
// 쓸 만한 게 없으면 ranked:[] — 화면이 코드 순서(fallbackOrder)를 쓴다. AI 호출이 실패하면 ok:false (이 경우도 화면이 코드 순서).
async function rankCandidates({ honorific, motion, candidates }) {
  const mo = cleanMotion(motion);
  if (!mo || !Array.isArray(candidates) || !candidates.length || candidates.length > 15) return { ok: false, reason: "BAD_INPUT" };
  const list = candidates.map(cleanCandidate);
  if (list.includes(null) || new Set(list.map((c) => c.id)).size !== list.length) return { ok: false, reason: "BAD_INPUT" };
  const raw = await askJSON(SYSTEM_CANDIDATES, userCandidates(typeof honorific === "string" && honorific.trim() ? honorific.trim().slice(0, 10) : "어르신", mo, list), { maxTokens: 700 });
  const ranked = (Array.isArray(raw?.ranked) ? raw.ranked : []).filter((r) => !BANNED_CANDIDATES.test(String(r?.reason ?? ""))); // 금지어 이유는 순번을 차지하지 않게 먼저 거른다
  return { ok: true, ranked: verifyCandidates({ ranked }, list, mo) };
}

export default postHandler(async (body) => {
  if (body?.mode === "gps") return gpsQuestions(body);
  if (body?.mode === "memory") return memoryPlaces(body);
  if (body?.mode === "candidates") return rankCandidates(body);
  const { spoken, knownPlaces = [], date } = body ?? {};
  if (!spoken || typeof spoken !== "string" || spoken.length > 1000) return { ok: false, reason: "BAD_INPUT" };
  const raw = await askJSON(SYSTEM_DIARY, userDiary(spoken, knownPlaces, date ?? new Date().toISOString().slice(0, 10)));
  const known = new Set(knownPlaces);
  // 코드 검증: 원문에 없는 장소는 버림, 이미 아는 장소는 new_places에서 제외
  const new_places = (raw?.new_places ?? []).filter((p) => p?.name && appearsInSource(p.name, spoken) && !known.has(p.name)).map((p) => ({ name: String(p.name).trim(), evidence: String(p.evidence ?? "").trim() }));
  const mentions = (raw?.mentions ?? []).filter((m) => m?.place && appearsInSource(m.place, spoken) && ["wish", "memory", "person"].includes(m.kind)).map((m) => ({ place: String(m.place).trim(), kind: m.kind, evidence: String(m.evidence ?? "").trim() }));
  const notes = typeof raw?.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;
  return { ok: true, extracted: { new_places, mentions, notes } };
});
