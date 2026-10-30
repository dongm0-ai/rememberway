// /api/push — 일지 알림 (웹 푸시)
//   GET                       → { ok, enabled, publicKey }  (저장소가 연결돼 있는지, 브라우저 구독에 쓸 공개키)
//   POST {action:"subscribe", sub, last}   구독 저장 (last: 이 기기에서 마지막으로 일지 쓴 날짜)
//   POST {action:"done", endpoint, date}   오늘 일지 썼음 → 오늘은 알림 안 감
//   POST {action:"test", endpoint}         지금 바로 테스트 알림 1번
//   POST {action:"unsubscribe", endpoint}  구독 해제
import { readJson, send, allowedOrigin } from "../lib/http.js";
import { kvReady } from "../lib/kv.js";
import { getVapid, saveSub, markDone, removeSub, allSubs, subId, todayKST } from "../lib/push-store.js";
import { sendPush } from "../lib/webpush.js";

export default async function handler(req, res) {
  try {
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
