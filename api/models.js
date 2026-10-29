// GET /api/models — 현재 키로 쓸 수 있는 Gemini 모델 목록 (기획안 5쪽 모델 비교·모델명 확인용). 키 값은 내보내지 않는다.
import { activeProvider, hasKey, currentModel, geminiBody } from "../lib/claude.js";
const PROVIDER = activeProvider();

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (!hasKey()) return res.end(JSON.stringify({ ok: false, reason: "NO_KEY", provider: PROVIDER }));
  if (PROVIDER === "upstage") {
    try {
      const r = await fetch("https://api.upstage.ai/v1/models", { headers: { authorization: `Bearer ${process.env.UPSTAGE_API_KEY}` } });
      const data = await r.json();
      return res.end(JSON.stringify({ ok: r.ok, provider: "upstage", using: currentModel(), models: (data.data ?? []).map((m) => ({ name: m.id })), error: data.error?.message }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 200) })); }
  }
  if (PROVIDER !== "gemini") return res.end(JSON.stringify({ ok: false, reason: "NOT_SUPPORTED", provider: PROVIDER }));
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
    const data = await r.json();
    const models = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => ({ name: m.name.replace(/^models\//, ""), display: m.displayName, in: m.inputTokenLimit, out: m.outputTokenLimit }));
    // ?test=a,b,c → 각 모델로 짧은 JSON 추출을 한 번씩 돌려 응답 시간을 잰다 (모델 선택·기획안 5쪽 근거용)
    const test = new URL(req.url, "http://x").searchParams.get("test");
    let timings;
    if (test) {
      timings = [];
      for (const name of test.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6)) {
        const t0 = Date.now();
        try {
          const sys = "보호자의 말에서 오늘 목적지만 JSON {\"today_destination\": string|null} 로. 원문에 없으면 null.";
          const call = (off) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`, {
            method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
            body: JSON.stringify(geminiBody(sys, "아버지가 시장 간다고 나가셨어요", 200, true, off)), signal: AbortSignal.timeout(12000),
          });
          let rr = await call(true), thinking = "off";
          if (rr.status === 400) { rr = await call(false); thinking = "default"; }
          const d = await rr.json();
          timings.push({ name, ms: Date.now() - t0, status: rr.status, thinking, text: (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).join("").slice(0, 80), error: d.error?.message?.slice(0, 100) });
        } catch (e) { timings.push({ name, ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 100) }); }
      }
    }
    res.end(JSON.stringify({ ok: r.ok, status: r.status, using: currentModel(), models, timings, error: data.error?.message }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 200) }));
  }
}
