// 금지어 코드 필터 — PRODUCT.md "금지어" 줄과 같은 범위인지 지키는 시험 (예상 후보지 이유: 확률·%·AI가 추천·실종 가능성은 버리고, "예측"은 기능 이름이라 거르지 않는다)
import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/diary.js";

let n = 0;
function post(body) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, end(s) { resolve(JSON.parse(s)); } };
    handler({ method: "POST", headers: { origin: "http://localhost:3000", "x-forwarded-for": `banned-words-test-${++n}` }, body }, res);
  });
}
const cand = (id) => ({ id, name: `장소${id}`, source: "memory", evidence: "예전에 다니셨어요", dist_m: 1200, bearing_diff_deg: 10, reachable: true, path_dist_m: 80 });
const body = () => ({ mode: "candidates", honorific: "아버지", motion: { state: "moving_lost", minutes_since: 40, speed_kmh: 3.6, direction_8: "북동" }, candidates: [cand("c1"), cand("c2"), cand("c3"), cand("c4")] });

/** 실제 제공자(Claude)를 가짜 fetch로 대신해 원하는 JSON을 돌려준다 */
async function withFakeAI(reply, fn) {
  const keys = ["MOCK_AI", "UPSTAGE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"], prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  delete process.env.MOCK_AI; delete process.env.UPSTAGE_API_KEY; delete process.env.GEMINI_API_KEY; process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { content: [{ type: "text", text: JSON.stringify(reply) }] }; }, async text() { return ""; } });
  try { return await fn(); } finally { globalThis.fetch = realFetch; for (const k of keys) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
}

for (const word of ["확률", "%", "AI가 추천", "실종 가능성"]) {
  test(`candidates mode drops a reason containing "${word}" before it takes one of the 3 slots`, () => withFakeAI(
    { ranked: [{ id: "c1", reason: `${word}이 높아요` }, { id: "c2", reason: "첫째예요" }, { id: "c3", reason: "둘째예요" }, { id: "c4", reason: "셋째예요" }] },
    async () => assert.deepEqual((await post(body())).ranked.map((r) => r.id), ["c2", "c3", "c4"])));
}

test('candidates mode does not filter "예측" (the feature is called prediction in code, 예상 후보지 on screen)', () => withFakeAI(
  { ranked: [{ id: "c1", reason: "가던 방향 예측에 가까워요" }, { id: "c2", reason: "둘째예요" }] },
  async () => assert.deepEqual((await post(body())).ranked.map((r) => r.id), ["c1", "c2"])));
