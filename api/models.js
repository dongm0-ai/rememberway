// GET /api/models — 현재 키로 쓸 수 있는 Gemini 모델 목록 (기획안 5쪽 모델 비교·모델명 확인용). 키 값은 내보내지 않는다.
import { PROVIDER, hasKey, currentModel } from "../lib/claude.js";

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (PROVIDER !== "gemini" || !hasKey()) return res.end(JSON.stringify({ ok: false, reason: "NO_KEY", provider: PROVIDER }));
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
    const data = await r.json();
    const models = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => ({ name: m.name.replace(/^models\//, ""), display: m.displayName, in: m.inputTokenLimit, out: m.outputTokenLimit }));
    res.end(JSON.stringify({ ok: r.ok, status: r.status, using: currentModel(), models, error: data.error?.message }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 200) }));
  }
}
