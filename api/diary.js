// POST /api/diary — 호출 ⑤ 일지 발화 → new_places / mentions / notes
// 칩만 탭한 날은 이 라우트를 부르지 않는다. "다른 곳이 있어요"로 말했을 때만.
// body: { spoken: string, knownPlaces: string[], date: string }
import { askJSON } from "../lib/claude.js";
import { SYSTEM_DIARY, userDiary } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { appearsInSource } from "../public/lib/verify.js";

export default postHandler(async ({ spoken, knownPlaces = [], date }) => {
  if (!spoken || typeof spoken !== "string" || spoken.length > 1000) return { ok: false, reason: "BAD_INPUT" };
  const raw = await askJSON(SYSTEM_DIARY, userDiary(spoken, knownPlaces, date ?? new Date().toISOString().slice(0, 10)));
  const known = new Set(knownPlaces);
  // 코드 검증: 원문에 없는 장소는 버림, 이미 아는 장소는 new_places에서 제외
  const new_places = (raw?.new_places ?? []).filter((p) => p?.name && appearsInSource(p.name, spoken) && !known.has(p.name)).map((p) => ({ name: String(p.name).trim(), evidence: String(p.evidence ?? "").trim() }));
  const mentions = (raw?.mentions ?? []).filter((m) => m?.place && appearsInSource(m.place, spoken) && ["wish", "memory", "person"].includes(m.kind)).map((m) => ({ place: String(m.place).trim(), kind: m.kind, evidence: String(m.evidence ?? "").trim() }));
  const notes = typeof raw?.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;
  return { ok: true, extracted: { new_places, mentions, notes } };
});
