// POST /api/followup — 호출 ② 빈 항목 → 되묻기 질문 (최대 3개)
// body: { clue: ClueJSON }
// 응답: { ok: true, questions: [{key, question}], missing } | { ok: false, reason }
import { askJSON } from "../lib/claude.js";
import { SYSTEM_FOLLOWUP, userFollowup } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { computeMissing } from "../public/lib/verify.js";
import { FOLLOWUP_PRIORITY } from "../public/lib/schema.js";

export default postHandler(async ({ clue }) => {
  if (!clue || typeof clue !== "object") return { ok: false, reason: "BAD_INPUT" };
  // missing은 코드가 다시 계산 (AI가 준 값을 믿지 않음)
  const missing = computeMissing(clue);
  if (missing.length === 0) return { ok: true, questions: [], missing };
  const raw = await askJSON(SYSTEM_FOLLOWUP, userFollowup(clue, missing));
  // 배열을 기대하지만, JSON 객체 모드인 모델(Upstage 등)은 {"questions":[...]}처럼 감싸서 줄 수 있다 → 안의 배열을 꺼낸다
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : (Object.values(raw ?? {}).find(Array.isArray) ?? []);
  const allowed = new Set(missing);
  // 코드 검증: 허용된 키만, 우선순위 순, 최대 3개, 한 키에 하나
  const seen = new Set();
  const questions = arr
    .filter((q) => q && typeof q === "object" && allowed.has(q.key) && typeof q.question === "string" && q.question.trim())
    .filter((q) => (seen.has(q.key) ? false : seen.add(q.key)))
    .map((q) => ({ key: q.key, question: q.question.trim() }))
    .sort((a, b) => FOLLOWUP_PRIORITY.indexOf(a.key) - FOLLOWUP_PRIORITY.indexOf(b.key))
    .slice(0, 3);
  return { ok: true, questions, missing };
});
