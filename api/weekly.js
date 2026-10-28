// POST /api/weekly — 호출 ⑥ 주간 요약 (코드가 집계한 숫자 → 문장)
// body: { summary: weeklyAggregate() 결과 }
import { askText } from "../lib/claude.js";
import { SYSTEM_WEEKLY, userWeekly } from "../lib/prompts.js";
import { postHandler } from "../lib/http.js";

export default postHandler(async ({ summary }) => {
  if (!summary || typeof summary !== "object") return { ok: false, reason: "BAD_INPUT" };
  const text = (await askText(SYSTEM_WEEKLY, userWeekly(summary), { maxTokens: 400 })).trim();
  // 코드 검증: 판단 문구 금지어가 들어오면 그 문장을 지운다
  const banned = /(위험|실종 가능성|예측|확률)/;
  const cleaned = text.split(/(?<=[.다요])\s+/).filter((s) => !banned.test(s)).join(" ").trim();
  return { ok: true, text: cleaned || text };
});
