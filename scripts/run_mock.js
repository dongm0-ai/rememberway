// 모의 사례 실행 스크립트: node scripts/run_mock.js
// .env.local 에 키가 있어야 함 (MOCK_AI=1 이면 키 없이 모의 응답으로 흐름만 점검).
// 결과를 data/results_<날짜>.json 에 저장 → docs/실험기록.md 에 수치를 옮겨 적는다 (탐구기록물).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
loadEnv(path.join(root, ".env.local"));

const { askJSON, MODEL, PROVIDER, isMock, currentModel } = await import("../lib/claude.js");
const { SYSTEM_EXTRACT, userExtract, SYSTEM_FOLLOWUP, userFollowup } = await import("../lib/prompts.js");
const { coerceClue, flagHallucinations, computeMissing, getPath } = await import("../public/lib/verify.js");

const { cases } = JSON.parse(fs.readFileSync(path.join(root, "data/mock_cases.json"), "utf8"));
const results = [];
console.log(`모델: ${isMock() ? "모의 응답(MOCK_AI=1, 실제 AI 아님)" : PROVIDER + " / " + MODEL}`);
for (const c of cases) {
  const t0 = Date.now();
  let raw;
  try { raw = await askJSON(SYSTEM_EXTRACT, userExtract(c.utterance, c.now, c.registered ?? undefined)); }
  catch (e) { console.log(`${c.id}: 실패 ${e.reason ?? e.message}`); results.push({ id: c.id, error: e.reason ?? String(e) }); continue; }
  const clue = coerceClue(raw);
  if (!clue) { console.log(`${c.id}: BAD_JSON`); results.push({ id: c.id, error: "BAD_JSON" }); continue; }
  const flagged = flagHallucinations(clue, c.utterance, c.registered ? JSON.stringify(c.registered) : undefined);
  const missing = computeMissing(flagged);
  let fu = [];
  try { fu = await askJSON(SYSTEM_FOLLOWUP, userFollowup(flagged, missing)); } catch (e) { fu = []; }
  if (!Array.isArray(fu)) { const raw = fu; fu = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : (raw && typeof raw === "object" && typeof raw.key === "string" && typeof raw.question === "string") ? [raw] : (Object.values(raw ?? {}).find(Array.isArray) ?? []); }
  const latency = Date.now() - t0;
  const hallucinated = (c.expected_null ?? []).filter((k) => { const v = getPath(flagged, k); return v !== null && v !== undefined; });
  const filled = Object.keys(c.expected_present ?? {}).filter((k) => { const v = getPath(flagged, k); return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0); });
  results.push({
    id: c.id, latency_ms: latency,
    filled_expected: `${filled.length}/${Object.keys(c.expected_present ?? {}).length}`,
    hallucinated_keys: hallucinated, unverified_flags: Object.keys(flagged.flags ?? {}),
    followup_first: fu?.[0]?.key, followup_first_ok: fu?.[0]?.key === c.expected_followup_first, followup_count: fu?.length ?? 0,
    clue: flagged, followup: fu,
  });
  console.log(`${c.id}: ${latency}ms, 채움 ${filled.length}/${Object.keys(c.expected_present ?? {}).length}, 환각 ${hallucinated.length}건${hallucinated.length ? ` (${hallucinated.join(",")})` : ""}, ⚠ ${Object.keys(flagged.flags ?? {}).length}건, 첫 되묻기 ${fu?.[0]?.key ?? "-"} ${fu?.[0]?.key === c.expected_followup_first ? "✓" : "✗(정답 " + c.expected_followup_first + ")"}`);
}
const out = path.join(root, `data/results_${new Date().toISOString().slice(0, 10)}${isMock() ? "_mock" : ""}.json`);
fs.writeFileSync(out, JSON.stringify({ model: isMock() ? "MOCK" : `${PROVIDER}/${currentModel()}`, ran_at: new Date().toISOString(), results }, null, 2));
console.log("saved", path.relative(root, out));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
