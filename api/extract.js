// POST /api/extract — 호출 ① 발화 → 단서 JSON (+ 검증 + 환각 플래그)
// body: { utterance: string, now?: string, registered?: object }
// 응답: { ok: true, clue } | { ok: false, reason } → 프론트는 ok:false면 서식 모드로
import { askJSON, AIError, currentModel, providerStatus } from "../lib/claude.js";
import { SYSTEM_EXTRACT, userExtract } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";
import { coerceClue, flagHallucinations } from "../public/lib/verify.js";

export default postHandler(async ({ utterance, now, registered }) => {
  if (!utterance || typeof utterance !== "string" || utterance.length > 3000) return { ok: false, reason: "BAD_INPUT" };
  const nowIso = now ?? new Date().toISOString();
  let lastErr = null;
  const t0 = Date.now();
  // 스키마 실패 시 1회 재요청 허용. 타임아웃·키 없음은 바로 서식 모드.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await askJSON(SYSTEM_EXTRACT, userExtract(utterance, nowIso, registered));
      const clue = coerceClue(raw);
      if (!clue) { lastErr = new AIError("BAD_JSON"); continue; }
      const flagged = flagHallucinations(clue, utterance, registered ? JSON.stringify(registered) : undefined);
      // ai: 어떤 생성형 AI가 몇 초 걸려 만들었는지, raw: 검증 전 AI 원본 — 화면 2 "생성형 AI가 한 일"에서 그대로 보여 준다 (원리 공개)
      return { ok: true, clue: flagged, attempt, raw, ai: { provider: providerStatus().lastUsed, model: currentModel(), ms: Date.now() - t0 } };
    } catch (e) {
      if (["TIMEOUT", "NO_KEY", "AI_UNAVAILABLE"].includes(e?.reason)) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new AIError("BAD_JSON");
});
