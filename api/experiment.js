// GET /api/experiment — data/mock_cases.json 3사례를 실제 AI로 돌려 지표를 돌려준다 (scripts/run_mock.js의 서버판).
// PC 설정 없이 폰·브라우저에서 바로 실험할 수 있게. 결과 수치는 docs/실험기록.md 에 손으로 옮겨 적는다.
// 모의 사례는 전부 가명·가짜 주소. 호출량 제한·출처 검사는 다른 API와 같다.
import fs from "node:fs";
import path from "node:path";
import { askJSON, currentModel, activeProvider, isMock, hasKey } from "../lib/claude.js";
import { SYSTEM_EXTRACT, userExtract, SYSTEM_FOLLOWUP, userFollowup } from "../lib/prompts.js";
import { coerceClue, flagHallucinations, computeMissing, getPath } from "../public/lib/verify.js";

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const src = req.headers.origin || req.headers.referer || "";
  let host = ""; try { host = new URL(src).host; } catch {}
  if (!(host === "rememberway.vercel.app" || host === "localhost:3000" || host.endsWith("-dongm0-ai.vercel.app"))) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, reason: "FORBIDDEN" })); }
  if (!isMock() && !hasKey()) return res.end(JSON.stringify({ ok: false, reason: "NO_KEY" }));

  const { cases } = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/mock_cases.json"), "utf8"));
  const only = new URL(req.url, "http://x").searchParams.get("case");
  const results = [];
  for (const c of cases.filter((c) => !only || c.id === only)) {
    const t0 = Date.now();
    let raw;
    try { raw = await askJSON(SYSTEM_EXTRACT, userExtract(c.utterance, c.now, c.registered ?? undefined)); }
    catch (e) { results.push({ id: c.id, title: c.title, error: e.reason ?? String(e), detail: e.detail?.slice(0, 120) }); continue; }
    const clue = coerceClue(raw);
    if (!clue) { results.push({ id: c.id, title: c.title, error: "BAD_JSON" }); continue; }
    const flagged = flagHallucinations(clue, c.utterance, c.registered ? JSON.stringify(c.registered) : undefined);
    const missing = computeMissing(flagged);
    let fu = [];
    try { fu = await askJSON(SYSTEM_FOLLOWUP, userFollowup(flagged, missing)); } catch { fu = []; }
    const hallucinated = (c.expected_null ?? []).filter((k) => { const v = getPath(flagged, k); return v !== null && v !== undefined; });
    const expected = Object.keys(c.expected_present ?? {});
    const filled = expected.filter((k) => { const v = getPath(flagged, k); return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0); });
    results.push({
      id: c.id, title: c.title, latency_ms: Date.now() - t0,
      filled: `${filled.length}/${expected.length}`, filled_missing: expected.filter((k) => !filled.includes(k)),
      hallucinated_keys: hallucinated, unverified_flags: Object.keys(flagged.flags ?? {}),
      followup_first: fu?.[0]?.key ?? null, followup_first_ok: (fu?.[0]?.key ?? null) === c.expected_followup_first, expected_followup_first: c.expected_followup_first,
      followup_count: Array.isArray(fu) ? fu.length : 0, clue: flagged, followup: fu,
    });
  }
  res.end(JSON.stringify({ ok: true, provider: activeProvider(), model: isMock() ? "MOCK(실제 AI 아님)" : currentModel(), ran_at: new Date().toISOString(), results }, null, 2));
}
