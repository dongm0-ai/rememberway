// POST /api/diary — 호출 ⑤ 일지 발화 → new_places / mentions / notes
//                  호출 ⑦ (mode:"gps") GPS 자주 머문 곳 → 보호자 되묻기 질문 + 정리 문장 (Vercel 함수 12개 한도로 이 파일에 합침)
// 칩만 탭한 날은 이 라우트를 부르지 않는다. "다른 곳이 있어요"로 말했을 때만.
// body: { spoken: string, knownPlaces: string[], date: string }
import { askJSON } from "../lib/claude.js";
import { SYSTEM_DIARY, userDiary, SYSTEM_GPS, userGps } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { appearsInSource } from "../public/lib/verify.js";

const BANNED = /(위험|예측|확률|실종 가능성|AI가 추천)/;

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

export default postHandler(async (body) => {
  if (body?.mode === "gps") return gpsQuestions(body);
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
