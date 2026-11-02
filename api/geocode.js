// GET /api/geocode?q=대전 중구 석교동 — 집 동네 → 좌표 (네이버만, lib/naver.js). 우리 앱 화면에서 온 요청만.
import { guardGet } from "../lib/http.js";
import { naverGeocode } from "../lib/naver.js";

export default async function handler(req, res) {
  if (!guardGet(req, res)) return;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const q = new URL(req.url, "http://x").searchParams.get("q")?.trim();
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  try {
    const hit = await naverGeocode(q);
    if (!hit) return res.end(JSON.stringify({ ok: false, reason: "NOT_FOUND" }));
    res.setHeader("cache-control", "private, max-age=86400");
    res.end(JSON.stringify({ ok: true, ...hit }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
