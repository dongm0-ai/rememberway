// POST /api/record — 호출 ④ 찾은 뒤 사건 서술 → 예방 계획 (화면 4)
// body: { narrative: string, clue?: ClueJSON, date?: string }
import { askJSON } from "../lib/claude.js";
import { SYSTEM_RECORD, userRecord } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { appearsInSource } from "../public/lib/verify.js";

export default postHandler(async ({ narrative, clue, date }) => {
  if (!narrative || typeof narrative !== "string" || narrative.length > 3000) return { ok: false, reason: "BAD_INPUT" };
  const raw = await askJSON(SYSTEM_RECORD, userRecord(narrative, clue, date ?? new Date().toISOString().slice(0, 10)));
  const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
  const src = narrative;
  const flags = {};
  const found_place = str(raw?.found_place);
  if (found_place && !appearsInSource(found_place, src)) flags.found_place = "unverified";
  const went_toward = str(raw?.went_toward);
  if (went_toward && !appearsInSource(went_toward, src)) flags.went_toward = "unverified";
  const found_by = ["가족", "경찰", "시민", "본인 귀가"].includes(raw?.found_by) ? raw.found_by : null;
  const banned = /(약을 바꾸|복용량|진단|처방|CCTV|GPS|위치추적기)/;
  const prevention = (Array.isArray(raw?.prevention) ? raw.prevention : [])
    .filter((p) => p && str(p.action) && !banned.test(p.action))
    .map((p) => ({ action: str(p.action), because: str(p.because) ?? "" }))
    .slice(0, 3);
  // 코드 검증: 원문에 없는 장소는 버림
  const add_places = (Array.isArray(raw?.add_places) ? raw.add_places : [])
    .filter((p) => p && str(p.name) && appearsInSource(p.name, src))
    .map((p) => ({ name: str(p.name), evidence: str(p.evidence) ?? "" }))
    .slice(0, 3);
  return { ok: true, record: { found_place, found_place_evidence: str(raw?.found_place_evidence), found_by, went_toward, elapsed_note: str(raw?.elapsed_note), prevention, add_places, flags } };
});
