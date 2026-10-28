// 로컬 개발 서버 (의존성 0). Vercel과 같은 규칙: public/ 은 정적 파일, api/*.js 는 서버 함수.
//   node scripts/dev.js          → http://localhost:3000
// .env.local 을 읽어 process.env 에 넣는다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
loadEnv(path.join(root, ".env.local"));

const PORT = Number(process.env.PORT || 3000);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, "");
      const file = path.join(root, "api", `${name}.js`);
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("no such api"); }
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`); // 매번 새로 읽음 (수정 즉시 반영)
      return mod.default(req, res);
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!path.extname(p) && fs.existsSync(path.join(root, "public", p + ".html"))) p += ".html"; // /report → report.html (Vercel cleanUrls)
    const file = path.join(root, "public", path.normalize(p));
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e); res.statusCode = 500; res.end("error");
  }
});
server.listen(PORT, () => console.log(`REMEMBER WAY AI dev → http://localhost:${PORT}  (MOCK_AI=${process.env.MOCK_AI ?? "0"}, key=${process.env.ANTHROPIC_API_KEY ? "있음" : "없음"})`));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
