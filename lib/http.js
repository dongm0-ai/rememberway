// Vercel 서버리스 함수 공통 도우미 (의존성 0)
import { isMock, hasKey, PROVIDER, currentModel } from "./claude.js";

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

// ---------------------------------------------------------------- 키 남용 방지 (할당량을 남이 태우지 못하게)
// 1) 우리 앱 화면에서 온 요청만 받는다 (Origin/Referer가 우리 도메인). 2) IP마다 분당 호출 수 제한. 3) 하루 전체 호출 수 상한.
// 서버리스 인스턴스마다 카운터가 따로 있어 완벽하진 않지만, 무차별 호출은 막는다. 더 강한 보호가 필요하면 Vercel KV로 옮긴다.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "rememberway.vercel.app,localhost:3000").split(",").map((s) => s.trim()).filter(Boolean);
const PER_MIN = Number(process.env.RATE_PER_MIN || 20);      // IP당 1분에 20회
const PER_DAY = Number(process.env.RATE_PER_DAY || 2000);    // 인스턴스당 하루 2000회
const ipHits = new Map(); let dayCount = 0, dayStamp = "";

function allowedOrigin(req) {
  const src = req.headers.origin || req.headers.referer || "";
  if (!src) return process.env.ALLOW_NO_ORIGIN === "1"; // 스크립트(run_mock)는 서버에서 직접 lib을 쓰므로 여기 안 옴
  try { const h = new URL(src).host; return ALLOWED_HOSTS.includes(h) || h.endsWith("-dongm0-ai.vercel.app"); } catch { return false; }
}
function rateOk(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").toString().split(",")[0].trim();
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (dayStamp !== today) { dayStamp = today; dayCount = 0; }
  if (++dayCount > PER_DAY) return false;
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 5000) ipHits.clear();
  return arr.length <= PER_MIN;
}

/** POST만 허용 + 출처·호출량 검사 + 본문 파싱 + 공통 오류 응답. handler(body) → {ok:true,...} 를 돌려주면 200 */
export function postHandler(handler) {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "METHOD" });
    if (!allowedOrigin(req)) return send(res, 403, { ok: false, reason: "FORBIDDEN" });
    if (!rateOk(req)) return send(res, 429, { ok: false, reason: "RATE_LIMIT" });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { ok: false, reason: "BAD_INPUT" }); }
    try {
      const out = await handler(body);
      return send(res, 200, out);
    } catch (e) {
      const reason = e?.reason ?? "AI_UNAVAILABLE";
      if (process.env.NODE_ENV !== "production") console.error("[api]", reason, e?.detail ?? e?.message ?? e);
      // detail: AI 서비스가 돌려준 오류 문구(키 값은 포함되지 않음). 원인 파악용으로 화면에 짧게 보여 준다.
      const detail = typeof e?.detail === "string" ? e.detail.replace(/AIza[0-9A-Za-z_-]+/g, "[key]").slice(0, 200) : undefined;
      return send(res, 200, { ok: false, reason: ["NO_KEY", "TIMEOUT", "NO_JSON", "BAD_JSON"].includes(reason) ? reason : "AI_UNAVAILABLE", detail });
    }
  };
}

export const aiStatus = () => ({ mock: isMock(), hasKey: hasKey(), provider: PROVIDER, model: currentModel() });
