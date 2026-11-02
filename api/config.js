// GET /api/config — 브라우저에 줘도 되는 설정만 (AI 상태). 비밀 키는 절대 내보내지 않는다.
import { aiStatus } from "../lib/http.js";

export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // 지도는 네이버만 (2026-11-02). 네이버 지도 Client ID는 원래 브라우저에 공개되는 값이고, 네이버클라우드 콘솔의 "Web 서비스 URL"로 우리 도메인만 쓰게 묶는다. Secret은 절대 내보내지 않는다.
  res.end(JSON.stringify({ ai: aiStatus(), map: { provider: "naver", naverClientId: process.env.NAVER_CLIENT_ID || null } }));
}
