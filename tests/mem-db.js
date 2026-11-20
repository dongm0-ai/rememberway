// 테스트용 메모리 저장소 — lib/kv.js 의 db(method, path, body?, prefer?) 와 같은 모양으로, api/loc.js 가 쓰는 PostgREST 문법만 흉내 낸다.
// (eq · neq · gt · gte · lt · in.(…) · is.null 필터, select, order, limit, offset, return=representation, resolution=merge-duplicates/ignore-duplicates)
// 실제 Supabase 에는 아무것도 쓰지 않는다. 이 파일은 *.test.js 가 아니라서 단독으로 실행되지 않는다.
import { randomUUID } from "node:crypto";

const PK = { device_status: "dev", revoked_devices: "device_hash", device_commands: "id", elders: "id", loc_events: "id" };
const UUID_ID = new Set(["device_commands", "elders"]);

function parse(path) {
  const [table, qs = ""] = path.split("?");
  const filters = []; let select = null, order = [], limit = Infinity, offset = 0;
  for (const part of qs.split("&").filter(Boolean)) {
    const i = part.indexOf("="); const k = part.slice(0, i); const v = decodeURIComponent(part.slice(i + 1));
    if (k === "select") select = v === "*" ? null : v.split(",");
    else if (k === "order") order = v.split(",").map((s) => { const [c, d] = s.split("."); return [c, d === "desc" ? -1 : 1]; });
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else {
      const j = v.indexOf("."); const op = v.slice(0, j); const arg = v.slice(j + 1);
      filters.push([k, op, op === "in" ? arg.replace(/^\(|\)$/g, "").split(",") : arg]);
    }
  }
  return { table, filters, select, order, limit, offset };
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function match(row, filters) {
  return filters.every(([k, op, arg]) => {
    const v = row[k];
    switch (op) {
      case "eq": return String(v) === arg;
      case "neq": return String(v) !== arg;
      case "gt": return v != null && cmp(String(v), arg) > 0;
      case "gte": return v != null && cmp(String(v), arg) >= 0;
      case "lt": return v != null && cmp(String(v), arg) < 0;
      case "in": return arg.includes(String(v));
      case "is": return arg === "null" ? v == null : v != null;
      default: throw new Error("mem-db: unsupported filter " + op);
    }
  });
}

/** seed = { table: [rows] }. 반환한 db 에는 db.tables(표 내용), db.calls(부른 기록)가 붙어 있다 */
export function memDb(seed = {}) {
  const tables = {}; let serial = 0;
  const T = (name) => (tables[name] ??= []);
  for (const [name, rows] of Object.entries(seed)) T(name).push(...rows.map((r) => ({ ...r })));
  const calls = [];
  const db = async (method, path, body, prefer = "") => {
    calls.push({ method, path, body, prefer });
    const q = parse(path); const rows = T(q.table);
    const pick = (r) => (q.select ? Object.fromEntries(q.select.map((c) => [c, r[c] ?? null])) : { ...r });
    if (method === "GET") {
      let out = rows.filter((r) => match(r, q.filters));
      for (const [c, d] of [...q.order].reverse()) out = out.slice().sort((a, b) => d * cmp(a[c], b[c]));
      return out.slice(q.offset, q.offset + q.limit).map(pick);
    }
    if (method === "POST") {
      const made = [];
      for (const b of Array.isArray(body) ? body : [body]) {
        const pk = PK[q.table]; const row = { ...b };
        if (pk === "id" && row.id == null) row.id = UUID_ID.has(q.table) ? randomUUID() : ++serial;
        const old = pk ? rows.find((r) => r[pk] === row[pk]) : null;
        if (old) {
          if (prefer.includes("merge-duplicates")) Object.assign(old, row);
          else if (!prefer.includes("ignore-duplicates")) throw Object.assign(new Error("duplicate key"), { reason: "STORE_ERROR" });
          made.push(old);
        } else { rows.push(row); made.push(row); }
      }
      return prefer.includes("return=representation") ? made.map((r) => ({ ...r })) : null;
    }
    if (method === "PATCH") { for (const r of rows) if (match(r, q.filters)) Object.assign(r, body); return null; }
    if (method === "DELETE") { tables[q.table] = rows.filter((r) => !match(r, q.filters)); return null; }
    throw new Error("mem-db: unsupported method " + method);
  };
  db.tables = tables; db.calls = calls;
  return db;
}
