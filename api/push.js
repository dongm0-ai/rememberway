// /api/push — 일지 알림 (웹 푸시)
//   GET                       → { ok, enabled, publicKey }  (저장소가 연결돼 있는지, 브라우저 구독에 쓸 공개키)
//   POST {action:"subscribe", sub, last}   구독 저장 (last: 이 기기에서 마지막으로 일지 쓴 날짜)
//   POST {action:"done", endpoint, date}   오늘 일지 썼음 → 오늘은 알림 안 감
//   POST {action:"test", endpoint}         지금 바로 테스트 알림 1번
//   POST {action:"unsubscribe", endpoint}  구독 해제
//   GET ?cron=1&round=1|2     → Vercel Cron(매일 18시·21시)이 부름: 오늘 일지 안 쓴 구독에만 알림 (무료 플랜 함수 12개 제한 때문에 한 파일로 합침)
import { readJson, send, allowedOrigin } from "../lib/http.js";
import { kvReady } from "../lib/kv.js";
import { getVapid, saveSub, markDone, removeSub, allSubs, subId, todayKST } from "../lib/push-store.js";
import { sendPush } from "../lib/webpush.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET" && new URL(req.url, "http://x").searchParams.get("cron")) return cron(req, res);
    if (req.method === "GET") {
      if (!kvReady()) return send(res, 200, { ok: true, enabled: false, reason: "NO_STORE" });
      const v = await getVapid();
      return send(res, 200, { ok: true, enabled: true, publicKey: v.publicKey });
    }
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "METHOD" });
    if (!allowedOrigin(req)) return send(res, 403, { ok: false, reason: "FORBIDDEN" });
    if (!kvReady()) return send(res, 200, { ok: false, reason: "NO_STORE" });
    const b = await readJson(req);
    const valid = (s) => s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys?.p256dh && s.keys?.auth;
    if (b.action === "subscribe") {
      if (!valid(b.sub)) return send(res, 400, { ok: false, reason: "BAD_INPUT" });
      await saveSub(b.sub, typeof b.last === "string" ? b.last.slice(0, 10) : null);
      return send(res, 200, { ok: true });
    }
    if (b.action === "done") return send(res, 200, { ok: await markDone(b.endpoint, (b.date || todayKST()).slice(0, 10)) });
    if (b.action === "unsubscribe") { await removeSub(b.endpoint); return send(res, 200, { ok: true }); }
    if (b.action === "test") {
      const me = (await allSubs()).find((x) => x.id === subId(b.endpoint));
      if (!me) return send(res, 200, { ok: false, reason: "NOT_SUBSCRIBED" });
      const r = await sendPush(me.sub, { title: "REMEMBER WAY", body: "알림이 잘 와요! 매일 저녁 6시에 일지를 안 쓰셨으면 알려 드릴게요.", url: "/diary" }, await getVapid());
      if (r.gone) await removeSub(b.endpoint);
      return send(res, 200, { ok: r.status < 300, status: r.status });
    }
    return send(res, 400, { ok: false, reason: "BAD_ACTION" });
  } catch (e) {
    return send(res, 200, { ok: false, reason: e?.reason || "PUSH_ERROR", detail: String(e?.message || e).slice(0, 120) });
  }
}

async function cron(req, res) {
  // Vercel은 CRON_SECRET 환경변수가 있으면 Authorization: Bearer <CRON_SECRET> 을 붙여 부른다. 없으면 Vercel Cron 요청만 허용.
  const secret = process.env.CRON_SECRET;
  const fromCron = /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (secret ? (req.headers.authorization || "") !== `Bearer ${secret}` : !fromCron) return send(res, 401, { ok: false, reason: "UNAUTHORIZED" });
  if (!kvReady()) return send(res, 200, { ok: false, reason: "NO_STORE" });
  const round = new URL(req.url, "http://x").searchParams.get("round") === "2" ? 2 : 1;
  const today = todayKST();
  const vapid = await getVapid();
  const msg = round === 1
    ? { title: "오늘 일지를 아직 안 쓰셨어요", body: "어르신이 오늘 어디 다녀오셨는지 10초만 남겨 주세요. 다음 실종 때 큰 도움이 됩니다.", url: "/diary" }
    : { title: "잊지 마세요 — 오늘 일지", body: "아직 오늘 기록이 없어요. 다녀온 곳을 눌러 저장만 하면 끝나요.", url: "/diary" };
  let sent = 0, skipped = 0, removed = 0, failed = 0;
  for (const s of await allSubs()) {
    if (s.last === today) { skipped++; continue; }
    try { const r = await sendPush(s.sub, msg, vapid); if (r.gone) { await removeSub(s.sub.endpoint); removed++; } else if (r.status < 300) sent++; else failed++; }
    catch { failed++; }
  }
  return send(res, 200, { ok: true, round, today, sent, skipped, removed, failed });
}
