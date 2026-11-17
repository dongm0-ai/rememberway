// 보호자 계정 — 어르신·가족(member)·초대·저장 규칙. 서버 함수(api/loc.js)에서만 쓴다. 의존성 0.
// db 는 lib/kv.js 의 db(method, path, body?, prefer?) 와 같은 모양 (테스트는 메모리 가짜 db).
// 모든 함수는 { ok:true, ... } 또는 { ok:false, reason } 을 돌려준다. 저장소 장애는 db 가 던지는 그대로 올려 보낸다.
//   reason: BAD_INPUT · GONE · NOT_OWNER · CONFLICT · INVITE_USED · INVITE_EXPIRED · INVITE_NOT_FOUND
//           DEVICE_TAKEN · DEVICE_REVOKED · USE_LEAVE · NO_SUCH_MEMBER
//   GONE = "이 어르신은 (나에게) 없음": 어르신이 지워졌거나, 있더라도 내가 member 가 아님 — 둘을 같은 답으로 돌려
//          member 가 아닌 사람에게 어르신이 있는지조차 알려 주지 않는다. 클라이언트는 어느 쪽이든 그 어르신 사본을 지운다.
//   inviteAccept 의 { ok:true, elderId, already:true } = 이미 그 어르신의 member 라 아무것도 바꾸지 않았음
//          (초대는 쓰지 않고 그대로 남아 다른 가족이 쓸 수 있음, 내 역할도 그대로 — owner 가 자기 QR 을 찍어도 무해).
//   초대는 만든 사람이 아직 member 일 때만 유효: 내보내지거나 빠지면 그 사람이 만든 안 쓴 초대는 지우고,
//          남아 있더라도(경쟁 상태) 받을 때 INVITE_NOT_FOUND.
// 권한: 어르신 데이터를 읽고 쓰려면 elder_members 에 있어야 한다. owner 만 내보내기·어르신 삭제·연결 코드 재발급.
// 서버에 남기는 것: 연결 코드·초대 토큰은 해시만. 사람 정보는 Auth 의 이메일뿐 (여기선 다루지 않음).
import { createHash, randomBytes, randomUUID } from "node:crypto";

const INVITE_MS = 24 * 3600 * 1000;   // 초대: 24시간, 1회
const CODE_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";   // 32글자 → 바이트 & 31 이 고르게 나뉜다
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Z2-7]{16}$/;
const LABEL_MAX = 20;

/** 연결 코드 → 서버에 남기는 해시. api/loc.js 의 devOf 와 같은 식 (기존 연결 코드와 호환) */
export const deviceHashOf = (code) => createHash("sha256").update("rw-loc:" + code).digest("hex").slice(0, 32);
const tokenHashOf = (token) => createHash("sha256").update(token).digest("hex");
const newDeviceCode = () => Array.from(randomBytes(16), (b) => CODE_ALPHA[b & 31]).join("");
const defaultToken = () => randomBytes(16).toString("base64url");

const fail = (reason) => ({ ok: false, reason });
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
const enc = encodeURIComponent;   // timestamptz 의 "+" 가 공백으로 읽히지 않게
const dataOf = (r) => ({ profile: r.profile ?? null, diary: r.diary ?? [], incidents: r.incidents ?? [], updated_at: r.updated_at });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function familyApi({ db, now = () => new Date(), randomToken = defaultToken }) {
  const iso = (ms = now().getTime()) => new Date(ms).toISOString();

  /** user 가 elderId 의 member 인지 확인. 통과하면 { elder, role } (+ last_seen 갱신), 아니면 실패 객체 */
  async function access(user, elderId, { owner = false } = {}) {
    if (!isUuid(user?.id) || !isUuid(elderId)) return fail("BAD_INPUT");
    // member 확인이 먼저: member 가 아니면 어르신이 있든 없든 같은 GONE (있는지 알려 주지 않음)
    const [m] = (await db("GET", `elder_members?elder_id=eq.${elderId}&user_id=eq.${user.id}&select=role`)) ?? [];
    if (!m) return fail("GONE");
    const [elder] = (await db("GET", `elders?id=eq.${elderId}&select=id,label,device_hash`)) ?? [];
    if (!elder) return fail("GONE");
    if (owner && m.role !== "owner") return fail("NOT_OWNER");
    await db("PATCH", `elders?id=eq.${elderId}`, { last_seen: iso() }).catch(() => {});   // 표시용 — 실패해도 요청은 계속
    return { ok: true, elder, role: m.role };
  }

  /** 남은 사람이 있는데 owner 가 없으면 가장 먼저 들어온 사람을 owner 로. 남은 사람이 없으면 false */
  async function handOff(elderId) {
    const left = (await db("GET", `elder_members?elder_id=eq.${elderId}&select=user_id,role,joined_at&order=joined_at.asc,user_id.asc`)) ?? [];
    if (!left.length) return false;
    if (!left.some((m) => m.role === "owner")) {
      await db("PATCH", `elder_members?elder_id=eq.${elderId}&user_id=eq.${left[0].user_id}`, { role: "owner" });
    }
    return true;
  }

  /** 그 사람이 이 어르신에 만들어 둔 안 쓴 초대 삭제 (내보내기·빠지기 때) */
  const dropInvites = (elderId, userId) => db("DELETE", `invites?elder_id=eq.${elderId}&created_by=eq.${userId}&used_at=is.null`);

  const currentHash = async (elderId) => ((await db("GET", `elders?id=eq.${elderId}&select=device_hash`)) ?? [])[0]?.device_hash;

  /** 재발급(새로 만든 코드): 옛 해시 폐기 → 옛 위치 기록을 새 해시로 옮김 → elders.device_hash 변경.
   *  폐기가 먼저라 옛 코드의 push 는 그 뒤로 410 — 옮기는 사이 옛 해시로 새 기록이 쌓이지 않는다.
   *  다시 시도해도 안전: 폐기는 중복 무시, 옮기기는 남은 것만, elders 변경이 실패하면 옮긴 기록을 되돌린다
   *  (새 해시는 방금 만든 것이라 그 아래 기록은 모두 이 어르신 것). 변경은 됐는데 응답만 잃었으면 되돌리지 않고 성공. */
  async function swapFresh(elder, newHash) {
    const old = elder.device_hash;
    if (old) {
      await db("POST", "revoked_devices", { device_hash: old, revoked_at: iso() }, "resolution=ignore-duplicates");
      await db("PATCH", `loc_events?dev=eq.${old}`, { dev: newHash });
    }
    try {
      await db("PATCH", `elders?id=eq.${elder.id}`, { device_hash: newHash });
    } catch (e) {
      let cur;
      try { cur = await currentHash(elder.id); } catch { throw e; }   // 상태를 모르면 되돌리지 않는다
      if (cur === newHash) return;   // 실제로는 바뀌었음 — 응답만 잃음
      if (old) await db("PATCH", `loc_events?dev=eq.${newHash}`, { dev: old }).catch(() => {});
      throw e;
    }
  }

  /** 어르신 데이터 전부 삭제: 연결 코드 폐기 → 위치 기록 → elders(members·data·invites 는 cascade) */
  async function purge(elder) {
    if (elder.device_hash) {
      await db("POST", "revoked_devices", { device_hash: elder.device_hash, revoked_at: iso() }, "resolution=ignore-duplicates");
      await db("DELETE", `loc_events?dev=eq.${elder.device_hash}`);
    }
    await db("DELETE", `elders?id=eq.${elder.id}`);
  }

  async function me(user) {
    if (!isUuid(user?.id)) return fail("BAD_INPUT");
    const ms = (await db("GET", `elder_members?user_id=eq.${user.id}&select=elder_id,role,joined_at&order=joined_at.asc`)) ?? [];
    if (!ms.length) return { ok: true, elders: [] };
    const es = (await db("GET", `elders?id=in.(${ms.map((m) => m.elder_id).join(",")})&select=id,label`)) ?? [];
    const label = new Map(es.map((e) => [e.id, e.label]));
    return { ok: true, elders: ms.filter((m) => label.has(m.elder_id)).map((m) => ({ id: m.elder_id, label: label.get(m.elder_id), role: m.role })) };
  }

  async function createElder(user, { label } = {}) {
    if (!isUuid(user?.id)) return fail("BAD_INPUT");
    const name = typeof label === "string" ? label.trim() : "";
    if (!name || name.length > LABEL_MAX) return fail("BAD_INPUT");
    const id = randomUUID();
    const deviceCode = newDeviceCode();
    const t = iso();
    await db("POST", "elders", { id, label: name, device_hash: deviceHashOf(deviceCode), created_at: t, last_seen: t });
    try {
      await db("POST", "elder_members", { elder_id: id, user_id: user.id, role: "owner", joined_at: t });
      await db("POST", "elder_data", { elder_id: id, profile: null, diary: [], incidents: [], updated_at: t });   // load 가 바로 되도록
    } catch (e) {
      await db("DELETE", `elders?id=eq.${id}`).catch(() => {});   // 반쯤 만든 어르신을 남기지 않는다
      throw e;
    }
    return { ok: true, elder: { id, label: name, role: "owner" }, deviceCode };
  }

  async function readData(elderId) {
    const [row] = (await db("GET", `elder_data?elder_id=eq.${elderId}&select=*`)) ?? [];
    if (row) return row;
    await db("POST", "elder_data", { elder_id: elderId, profile: null, diary: [], incidents: [], updated_at: iso() }, "resolution=ignore-duplicates");
    const [again] = (await db("GET", `elder_data?elder_id=eq.${elderId}&select=*`)) ?? [];
    return again;
  }

  async function load(user, elderId) {
    const a = await access(user, elderId);
    if (!a.ok) return a;
    const row = await readData(elderId);
    if (!row) return fail("GONE");
    return { ok: true, data: dataOf(row) };
  }

  /** base = 클라이언트가 마지막으로 받은 updated_at. 서버 값이 그보다 새로우면 CONFLICT + 서버 데이터 */
  async function save(user, elderId, { profile, diary, incidents, base } = {}) {
    const a = await access(user, elderId);
    if (!a.ok) return a;
    const patch = {};
    if (profile !== undefined) { if (profile !== null && !isObj(profile)) return fail("BAD_INPUT"); patch.profile = profile; }
    if (diary !== undefined) { if (!Array.isArray(diary)) return fail("BAD_INPUT"); patch.diary = diary; }
    if (incidents !== undefined) { if (!Array.isArray(incidents)) return fail("BAD_INPUT"); patch.incidents = incidents; }
    if (!Object.keys(patch).length) return fail("BAD_INPUT");

    const row = await readData(elderId);
    if (!row) return fail("GONE");
    const conflict = (r) => ({ ok: false, reason: "CONFLICT", data: dataOf(r) });
    const hasData = row.profile != null || (row.diary ?? []).length > 0 || (row.incidents ?? []).length > 0;
    if (base == null || base === "") {
      if (hasData) return conflict(row);   // 처음 올리는 기기인데 서버엔 이미 가족이 쓴 데이터가 있음
    } else if (typeof base !== "string" || Date.parse(base) !== Date.parse(row.updated_at)) {
      return conflict(row);
    }
    // 같은 밀리초 안의 저장이라도 updated_at 은 반드시 앞으로 간다
    patch.updated_at = iso(Math.max(now().getTime(), Date.parse(row.updated_at) + 1));
    // 조건부 PATCH: 읽은 뒤 다른 가족이 먼저 저장했으면 0행 → CONFLICT (경쟁 상태에서도 덮어쓰지 않음)
    const out = (await db("PATCH", `elder_data?elder_id=eq.${elderId}&updated_at=eq.${enc(row.updated_at)}`, patch, "return=representation")) ?? [];
    if (!out.length) {
      const cur = await readData(elderId);
      return cur ? conflict(cur) : fail("GONE");
    }
    return { ok: true, updated_at: out[0].updated_at };
  }

  async function inviteCreate(user, elderId) {
    const a = await access(user, elderId);
    if (!a.ok) return a;
    const token = randomToken();
    const expires_at = iso(now().getTime() + INVITE_MS);
    await db("POST", "invites", { token_hash: tokenHashOf(token), elder_id: elderId, created_by: user.id, expires_at, used_at: null });
    return { ok: true, token, expires_at };
  }

  async function inviteAccept(user, token) {
    if (!isUuid(user?.id)) return fail("BAD_INPUT");
    if (typeof token !== "string" || !token || token.length > 200) return fail("INVITE_NOT_FOUND");
    const h = tokenHashOf(token);
    const [inv] = (await db("GET", `invites?token_hash=eq.${h}&select=*`)) ?? [];
    if (!inv) return fail("INVITE_NOT_FOUND");   // 없거나, 어르신이 지워져 함께 지워짐
    // 만든 사람이 더는 member 가 아니면 그 초대는 없는 것 (내보내진 사람이 미리 만든 초대로 돌아오지 못하게)
    const [maker] = isUuid(inv.created_by)
      ? (await db("GET", `elder_members?elder_id=eq.${inv.elder_id}&user_id=eq.${inv.created_by}&select=role`)) ?? []
      : [];
    if (!maker) return fail("INVITE_NOT_FOUND");
    const [mine] = (await db("GET", `elder_members?elder_id=eq.${inv.elder_id}&user_id=eq.${user.id}&select=role`)) ?? [];
    if (mine) return { ok: true, elderId: inv.elder_id, already: true };   // 이미 가족 — 초대는 쓰지 않고 그대로 둔다
    if (inv.used_at) return fail("INVITE_USED");
    if (!(Date.parse(inv.expires_at) > now().getTime())) return fail("INVITE_EXPIRED");
    // 한 번만: 아직 안 쓴 초대일 때만 used_at 을 채운다 (동시에 두 사람이 받아도 한 명만)
    const took = (await db("PATCH", `invites?token_hash=eq.${h}&used_at=is.null`, { used_at: iso() }, "return=representation")) ?? [];
    if (!took.length) {   // 그 사이 다른 사람이 썼거나, 어르신이 지워져 초대도 함께 지워짐
      const [still] = (await db("GET", `invites?token_hash=eq.${h}&select=token_hash`)) ?? [];
      return fail(still ? "INVITE_USED" : "INVITE_NOT_FOUND");
    }
    // 그 사이 어르신이 지워졌으면 FK(elder_members → elders) 위반으로 db 가 던진다 → member 행이 생기지 않음 (닫힌 쪽으로 실패)
    await db("POST", "elder_members", { elder_id: inv.elder_id, user_id: user.id, role: "member", joined_at: iso() }, "resolution=ignore-duplicates");
    return { ok: true, elderId: inv.elder_id };
  }

  async function members(user, elderId) {
    const a = await access(user, elderId);
    if (!a.ok) return a;
    const rows = (await db("GET", `elder_members?elder_id=eq.${elderId}&select=user_id,role,joined_at&order=joined_at.asc,user_id.asc`)) ?? [];
    return { ok: true, members: rows.map((r) => ({ user_id: r.user_id, role: r.role, joined_at: r.joined_at, me: r.user_id === user.id })) };
  }

  async function removeMember(user, elderId, userId) {
    const a = await access(user, elderId, { owner: true });
    if (!a.ok) return a;
    if (!isUuid(userId)) return fail("BAD_INPUT");
    if (userId === user.id) return fail("USE_LEAVE");
    const gone = (await db("DELETE", `elder_members?elder_id=eq.${elderId}&user_id=eq.${userId}`, undefined, "return=representation")) ?? [];
    await dropInvites(elderId, userId);
    if (!gone.length) return fail("NO_SUCH_MEMBER");
    // 내가 동시에 빠지는 중이었다면(경쟁) owner 없는 어르신이 남지 않게, 아무도 안 남았으면 지운다
    if (!(await handOff(elderId))) { await purge(a.elder); return { ok: true, deleted: true }; }
    return { ok: true };
  }

  /** 빠지기. owner 가 빠지면 가장 먼저 들어온 사람이 owner, 마지막 사람이면 어르신 데이터 전부 삭제 */
  async function leave(user, elderId) {
    const a = await access(user, elderId);
    if (!a.ok) return a;
    const all = (await db("GET", `elder_members?elder_id=eq.${elderId}&select=user_id,role,joined_at&order=joined_at.asc,user_id.asc`)) ?? [];
    const rest = all.filter((m) => m.user_id !== user.id);
    if (!rest.length) { await purge(a.elder); return { ok: true, deleted: true }; }
    await db("DELETE", `elder_members?elder_id=eq.${elderId}&user_id=eq.${user.id}`);
    await dropInvites(elderId, user.id);
    // 다시 읽는다: 남은 사람이 동시에 빠졌으면 아무도 없는 어르신이 남지 않게 지우고, 아니면 owner 를 넘긴다
    if (!(await handOff(elderId))) { await purge(a.elder); return { ok: true, deleted: true }; }
    return { ok: true };
  }

  async function deleteElder(user, elderId) {
    const a = await access(user, elderId, { owner: true });
    if (!a.ok) return a;
    await purge(a.elder);
    return { ok: true };
  }

  /** 새 연결 코드로 바꾸고 옛 해시는 폐기 (옛 코드의 push 는 410). 위치 기록은 새 코드로 옮겨 이어진다 (찾는 중 재발급해도 흔적 유지) */
  async function resetDevice(user, elderId) {
    const a = await access(user, elderId, { owner: true });
    if (!a.ok) return a;
    const deviceCode = newDeviceCode();
    await swapFresh(a.elder, deviceHashOf(deviceCode));
    return { ok: true, deviceCode };
  }

  /** 첫 로그인 때 이 폰의 기존 rw_track 연결 코드를 이 어르신의 연결 코드로 (owner 만) */
  async function importDevice(user, elderId, code) {
    const a = await access(user, elderId, { owner: true });
    if (!a.ok) return a;
    const key = String(code ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");   // api/loc.js 와 같은 정리
    if (!KEY_RE.test(key)) return fail("BAD_INPUT");
    const h = deviceHashOf(key);
    if (h === a.elder.device_hash) return { ok: true };
    if (((await db("GET", `revoked_devices?device_hash=eq.${h}&select=device_hash`)) ?? []).length) return fail("DEVICE_REVOKED");
    if (((await db("GET", `elders?device_hash=eq.${h}&select=id`)) ?? []).length) return fail("DEVICE_TAKEN");
    // 가져오기는 elders 변경이 먼저: 동시에 두 어르신이 같은 코드를 가져오면 unique 제약이 한쪽만 통과시킨다.
    // 진 쪽은 아무것도 옮기지 않고 DEVICE_TAKEN — 진 쪽 기록이 이긴 쪽 해시로 넘어가 남의 가족에게 보이는 일이 없다.
    const old = a.elder.device_hash;
    try {
      await db("PATCH", `elders?id=eq.${elderId}`, { device_hash: h });
    } catch (e) {
      const [owner] = (await db("GET", `elders?device_hash=eq.${h}&select=id`).catch(() => null)) ?? [];
      if (owner && owner.id !== elderId) return fail("DEVICE_TAKEN");
      if (owner?.id !== elderId) throw e;   // 다른 장애 (owner 가 이 어르신이면 응답만 잃은 것 → 계속)
    }
    if (old) {
      try {
        // 그다음 옛 해시 폐기 → 옛 기록을 가져온 코드로 합침 (가져온 코드에 원래 있던 기록은 그 기기 것이라 그대로)
        await db("POST", "revoked_devices", { device_hash: old, revoked_at: iso() }, "resolution=ignore-duplicates");
        await db("PATCH", `loc_events?dev=eq.${old}`, { dev: h });
      } catch (e) {
        // 다시 시도할 수 있게 되돌린다: 옛 해시 폐기 취소 → 어르신을 옛 해시로 (옛 해시는 이 어르신 것이라 unique 문제 없음)
        await db("DELETE", `revoked_devices?device_hash=eq.${old}`).catch(() => {});
        await db("PATCH", `elders?id=eq.${elderId}`, { device_hash: old }).catch(() => {});
        throw e;
      }
    }
    return { ok: true };
  }

  /** 탈퇴: 모든 어르신에서 빠진다(leave 규칙). Auth 계정 삭제는 호출한 쪽(service_role)이 한다 */
  async function withdraw(user) {
    const m = await me(user);
    if (!m.ok) return m;
    for (const e of m.elders) {
      const r = await leave(user, e.id);
      if (!r.ok && r.reason !== "GONE") return r;   // 그 사이 지워졌거나 내보내졌으면 괜찮음
    }
    return { ok: true, deleteAuthUser: true };
  }

  return { me, createElder, load, save, inviteCreate, inviteAccept, members, removeMember, leave, deleteElder, resetDevice, importDevice, withdraw, deviceHashOf };
}
