// 웹 푸시 보내기 (의존성 0, Node crypto만). RFC 8291(aes128gcm 암호화) + RFC 8292(VAPID 서명).
// 일지 알림에만 쓴다. 보내는 내용은 "오늘 일지 아직 안 쓰셨어요" 같은 고정 문구뿐, 개인정보 없음.
import crypto from "node:crypto";

export const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** VAPID 키 한 쌍 새로 만들기 → { publicKey(65바이트 b64url), privateKey(32바이트 d b64url) } */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidAuthHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const pub = unb64u(vapid.publicKey); // 0x04 || x(32) || y(32)
  const key = crypto.createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** RFC 8291 aes128gcm 본문 만들기 */
function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** 구독 하나에 알림 보내기. 반환 { status, gone } — gone=true면 구독이 사라졌으니 지운다 */
export async function sendPush(subscription, message, vapid, subject = "mailto:dongm0-ai@users.noreply.github.com") {
  const body = encrypt(JSON.stringify(message), subscription.keys.p256dh, subscription.keys.auth);
  const r = await fetch(subscription.endpoint, {
    method: "POST",
    headers: { TTL: "43200", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: vapidAuthHeader(subscription.endpoint, vapid, subject) },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, gone: r.status === 404 || r.status === 410 };
}
