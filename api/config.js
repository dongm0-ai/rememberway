// GET /api/config — 브라우저에 줘도 되는 설정만 (카카오 JavaScript 키는 도메인 제한이 있는 공개 키. Claude 키는 절대 내보내지 않는다)
import { aiStatus } from "../lib/http.js";

export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ kakaoJsKey: process.env.KAKAO_JS_KEY || null, ai: aiStatus() }));
}
