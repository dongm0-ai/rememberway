// POST /api/gps — 호출 ⑦ GPS 기록에서 코드가 센 "오래 머문 곳" → 보호자에게 물을 질문 + 정리 문장
// body: { honorific, track:{days, period_days}, places:[{id, label(동 이름까지), days_n, avg_min, weekdays, hour_band}] }
// 좌표는 받지 않는다. 검증: id가 맞는지, label이 질문에 들어 있는지, 금지어·입력에 없는 숫자가 없는지 → 아니면 그 질문은 버리고 화면이 기본 질문을 쓴다.
import { askJSON } from "../lib/claude.js";
import { SYSTEM_GPS, userGps } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";

const BANNED = /(위험|예측|확률|실종 가능성|AI가 추천)/;

export default postHandler(async ({ honorific, track, places }) => {
  if (!Array.isArray(places) || !places.length || places.length > 12) return { ok: false, reason: "BAD_INPUT" };
  const clean = places.map((p) => ({ id: String(p.id).slice(0, 8), label: String(p.label ?? "").slice(0, 30), days_n: Number(p.days_n) || 0, avg_min: Number(p.avg_min) || 0, weekdays: (p.weekdays ?? []).slice(0, 2).map(String), hour_band: p.hour_band ? String(p.hour_band).slice(0, 12) : null }));
  const tr = { days: Number(track?.days) || 0, period_days: Number(track?.period_days) || 0 };
  const raw = await askJSON(SYSTEM_GPS, userGps(String(honorific ?? "어르신").slice(0, 10), tr, clean), { maxTokens: 900 });
  const inputNums = new Set((JSON.stringify({ tr, clean }).match(/\d+/g) ?? []));
  const numsOk = (s) => (s.match(/\d+/g) ?? []).every((n) => inputNums.has(n));
  const questions = (raw?.questions ?? []).map((q) => {
    const p = clean.find((x) => x.id === q?.id); const text = String(q?.question ?? "").trim();
    const ok = p && text && text.length <= 140 && !BANNED.test(text) && numsOk(text) && text.includes(p.label.replace(/ 어딘가$/, ""));
    return ok ? { id: p.id, question: text } : null;
  }).filter(Boolean);
  const summary = String(raw?.summary ?? "").split(/(?<=[.다요])\s+/).filter((s) => s && !BANNED.test(s) && numsOk(s)).join(" ").trim() || null;
  return { ok: true, summary, questions, dropped: clean.length - questions.length };
});
