// Vercel 서버리스 함수 공통 도우미 (의존성 0)
import { isMock, hasKey } from "./claude.js";

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel이 파싱해 준 경우
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return await new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ ...body, mock: isMock() || undefined }));
}

/** POST만 허용 + 본문 파싱 + 공통 오류 응답. handler(body) → {ok:true,...} 를 돌려주면 200 */
export function postHandler(handler) {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "METHOD" });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { ok: false, reason: "BAD_INPUT" }); }
    try {
      const out = await handler(body);
      return send(res, 200, out);
    } catch (e) {
      const reason = e?.reason ?? "AI_UNAVAILABLE";
      if (process.env.NODE_ENV !== "production") console.error("[api]", reason, e?.detail ?? e?.message ?? e);
      return send(res, 200, { ok: false, reason: ["NO_KEY", "TIMEOUT", "NO_JSON", "BAD_JSON"].includes(reason) ? reason : "AI_UNAVAILABLE" });
    }
  };
}

export const aiStatus = () => ({ mock: isMock(), hasKey: hasKey() });
