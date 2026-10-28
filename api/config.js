// GET /api/config — 브라우저에 줘도 되는 설정만 (AI 상태). 비밀 키는 절대 내보내지 않는다.
import { aiStatus } from "../lib/http.js";

export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ ai: aiStatus(), map: "openstreetmap" }));
}
