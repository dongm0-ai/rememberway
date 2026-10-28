// GET /api/config — 브라우저에 줘도 되는 설정만 (카카오 JavaScript 키는 도메인 제한이 있는 공개 키. Claude 키는 절대 내보내지 않는다)
import fs from "node:fs";
import path from "node:path";
import { aiStatus } from "../lib/http.js";

// 카카오 JavaScript 키: 환경변수 KAKAO_JS_KEY 가 있으면 그것, 없으면 data/public_config.json (공개 키, 도메인 제한으로 보호)
function kakaoKey() {
  if (process.env.KAKAO_JS_KEY) return process.env.KAKAO_JS_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/public_config.json"), "utf8")).kakaoJsKey || null; } catch { return null; }
}

export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ kakaoJsKey: kakaoKey(), ai: aiStatus() }));
}
