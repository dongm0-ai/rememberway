// 서비스워커: 화면 파일은 캐시해 두어 인터넷이 약해도 앱이 열리게 한다. /api/ 는 절대 캐시하지 않는다 (항상 서버).
const VERSION = "rw-v4";
const SHELL = ["/", "/index.html", "/report.html", "/confirm.html", "/summary.html", "/profile.html", "/diary.html", "/record.html", "/about.html", "/css/app.css", "/js/common.js", "/js/map.js", "/js/answer-ui.js", "/lib/schema.js", "/lib/verify.js", "/lib/priority.js", "/lib/diary.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return; // API·외부(지도 타일 등)는 캐시 안 함
  // 네트워크 우선, 실패하면 캐시 (/report 처럼 확장자 없는 주소는 .html 캐시로)
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
    .catch(async () => (await caches.match(e.request)) || (await caches.match(url.pathname + ".html")) || (await caches.match("/index.html"))));
});
