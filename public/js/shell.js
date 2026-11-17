// 앱 셸 — 모든 화면 공통: 로그인 확인, 어르신 고르기(위), 설정 ⚙(오른쪽 위), 고정 탭 3개(아래), 동기화 알림.
// 쓰는 법 (페이지 맨 앞): const { elder, offline } = await mountShell({ tab: "live" | "find" | "memory" | "settings" });
//   - 로그인 안 됨 → requireLogin() (로그인 화면으로 이동, 이 Promise 는 끝나지 않는다)
//   - 로그인 정보는 있는데 서버가 안 됨 → 오프라인: 이 폰의 마지막 사본(현재 어르신)으로 계속. elder 가 null 일 수 있다
//   - 어르신 0명 → 이 폰의 기존 등록 정보 올리기 질문 → 그래도 없으면 "어르신 등록"(호칭) 화면
//   - 현재 어르신을 고른 뒤 pull() — 이 폰 사본이 있으면 WAIT_MS 까지만 기다리고 사본으로 먼저 그린다(서버 장애 때 찾기 흐름이 막히지 않게)
// - 다른 가족이 먼저 고쳤으면(conflict) 안내 후 1.5초 뒤 새로고침 (화면이 들고 있는 옛 배열로 덮어쓰지 않게)
// - 어르신에 더 이상 접근할 수 없으면(gone) 안내 후 처음 화면으로
import { el, $ } from "./common.js";
import { session, storedSession, requireLogin, signOut, reasonText } from "./auth.js";
import { installSync, checkAccount, listElders, createElder, importLocalData, setCurrentElder, currentElder, pull, flush, onSync, CONFLICT_TEXT } from "./family.js";

export const TABS = [
  { id: "live", href: "/track", icon: "📍", label: "실시간 위치" },
  { id: "find", href: "/report", icon: "🚨", label: "실종자 찾기" },
  { id: "memory", href: "/profile", icon: "📝", label: "추억의 장소" },
];
export const GONE_TEXT = "이 어르신 정보에 더 이상 접근할 수 없어요";
const HOME_GONE_TEXT = "집 주소도 이 폰에서 지웠어요";
const OFFLINE_TEXT = "오프라인 — 이 폰의 마지막 사본";
const PENDING_TEXT = "아직 서버에 못 올린 변경이 있어요. 연결되면 다시 올려요.";
const LABEL_CHIPS = ["아버지", "어머니", "할아버지", "할머니", "어르신"];
const LABEL_MAX = 20;
const OFFLINE_REASONS = new Set(["NETWORK", "TIMEOUT", "AUTH_UNAVAILABLE", "NO_STORE", "STORE_ERROR", "RATE_LIMIT", "HTTP_502", "HTTP_503", "HTTP_504"]);
const WAIT_MS = 8000;      // 이 폰 사본이 있을 때 서버를 기다리는 최대 시간
const RELOAD_MS = 1500;

const ERR = {
  NETWORK: "인터넷 연결을 확인해 주세요.", TIMEOUT: "서버 응답이 늦어요. 잠시 뒤에 다시 해 주세요.",
  NOT_OWNER: "처음 등록한 가족(관리자)만 할 수 있어요.", GONE: GONE_TEXT, NOT_MEMBER: GONE_TEXT,
  BAD_INPUT: "입력한 내용을 다시 확인해 주세요.", NO_SUCH_MEMBER: "이미 빠진 가족이에요.",
  RATE_LIMIT: "요청이 너무 많았어요. 잠시 뒤에 다시 해 주세요.",
  AUTH_UNAVAILABLE: "로그인 서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요.",
  NO_STORE: "서버 저장소가 아직 연결되지 않았어요 (관리자 설정 필요).", STORE_ERROR: "서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요.",
  ACCOUNT_CHANGED: "다른 계정으로 로그인돼서 멈췄어요. 화면을 새로고침해 주세요.",
};
/** 서버 reason → 화면 문구 (설정·초대 화면도 같이 쓴다) */
export const errText = (reason) => ERR[reason] ?? (/^HTTP_5\d\d$/.test(String(reason)) ? ERR.STORE_ERROR : reasonText(reason));

// ---------------------------------------------------------------- 작은 UI 도우미
let toastBox = null, toastTimer = null;
/** 아래 탭 위에 잠깐 뜨는 한 줄 안내 */
export function toast(text, ms = 4000) {
  if (!toastBox) { toastBox = el("div", { class: "toast hidden", role: "status", "aria-live": "polite" }); document.body.append(toastBox); }
  toastBox.textContent = text;
  toastBox.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.add("hidden"), ms);
}

/** 확인 창 (큰 글씨·큰 버튼). → Promise<boolean>. 바깥 누르기·뒤로 가기(Esc)는 "아니요" */
export function confirmDialog(text, { ok = "네", cancel = "아니요", danger = false, detail = "", cancellable = true } = {}) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "shell-dialog", "aria-labelledby": "cd-title" });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(
      el("p", { id: "cd-title", class: "q", style: "margin-top:0" }, text),
      detail ? el("p", { class: "muted", style: "margin:0 0 6px" }, detail) : "",
      el("div", { class: "stack", style: "margin-top:14px" },
        el("button", { class: danger ? "btn-danger" : "btn-primary", onclick: () => done(true) }, ok),
        el("button", { class: "btn-secondary", onclick: () => done(false) }, cancel)));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (cancellable) done(false); });
    document.body.append(dlg); dlg.showModal();
  });
}

const callBox = () => el("div", { class: "alert", style: "margin-bottom:14px" }, "치매 어르신은 즉시 신고 대상입니다.", el("br"), "먼저 112에 전화하세요.",
  el("a", { class: "btn btn-danger btn-xl call112", href: "tel:112" }, "📞 112 전화하기"));

/** "어르신 등록" (호칭만). required 면 닫을 수 없다(어르신이 한 분도 없을 때). → Promise<{id,label,role}|null> */
export function registerElder({ required = false } = {}) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "shell-dialog shell-reg", "aria-labelledby": "reg-title" });
    const input = el("input", { type: "text", id: "reg-label", maxlength: String(LABEL_MAX), placeholder: "예) 아버지", autocomplete: "off", autofocus: "" });   // 첫 포커스가 112 버튼에 가지 않게
    const chips = LABEL_CHIPS.map((t) => el("button", { type: "button", class: "chip", "aria-pressed": "false", onclick: () => { input.value = t; sync(); } }, t));
    const sync = () => chips.forEach((c) => c.setAttribute("aria-pressed", String(c.textContent === input.value.trim())));
    input.addEventListener("input", sync);
    const msg = el("p", { class: "msg-err", role: "alert" });
    const go = el("button", { class: "btn-primary btn-xl", type: "submit" }, "등록하기");
    const skip = el("button", { type: "button", class: "btn-secondary", onclick: () => { dlg.close(); dlg.remove(); resolve(null); } }, "지금은 건너뛰기 (이 폰의 정보로 계속)");
    const form = el("form", { novalidate: "" },
      el("label", { for: "reg-label" }, `어르신을 부르는 호칭 (${LABEL_MAX}자까지)`),
      el("div", { class: "chips", style: "margin:6px 0 10px" }, chips), input, msg,
      el("div", { class: "stack", style: "margin-top:12px" }, go));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const label = input.value.trim();
      if (!label) { msg.textContent = "호칭을 고르거나 적어 주세요."; return input.focus(); }
      if ([...label].length > LABEL_MAX) { msg.textContent = `${LABEL_MAX}자까지 적을 수 있어요.`; return input.focus(); }
      go.disabled = true; go.textContent = "등록하는 중…"; msg.textContent = "";
      const r = await createElder(label).catch(() => ({ ok: false, reason: "NETWORK" }));
      go.disabled = false; go.textContent = "등록하기";
      if (!r.ok) {
        msg.textContent = errText(r.reason);
        // 어르신이 한 분도 없는데 서버에 닿지 않을 때: 막아 두지 않고 이 폰의 정보로 계속할 수 있게 (찾기 흐름·112는 써야 한다)
        if (required && OFFLINE_REASONS.has(r.reason) && !skip.isConnected) go.after(skip);
        return;
      }
      dlg.close(); dlg.remove();
      resolve({ id: r.elder.id, label: r.elder.label ?? label, role: r.elder.role ?? "owner" });
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!required) { dlg.close(); dlg.remove(); resolve(null); } });
    dlg.append(
      required ? callBox() : "",
      el("h2", { id: "reg-title", style: "margin-top:0" }, "어르신 등록"),
      el("p", { class: "muted", style: "margin:0 0 4px" }, "이름은 받지 않아요. 가족끼리 부르는 호칭만 정해 주세요."),
      form,
      required
        ? el("div", { class: "small muted", style: "margin-top:14px" },
            el("p", {}, "가족에게 초대를 받으셨으면 받은 링크(QR)를 열어 주세요. 등록하지 않아도 바로 함께 볼 수 있어요."),
            el("button", { type: "button", class: "btn-ghost", onclick: async () => { await signOut().catch(() => {}); location.replace("/login"); } }, "다른 계정으로 로그인"))
        : el("button", { type: "button", class: "btn-ghost", style: "margin-top:8px", onclick: () => { dlg.close(); dlg.remove(); resolve(null); } }, "닫기"));
    document.body.append(dlg); dlg.showModal();
  });
}

const askImport = (text) => confirmDialog(text, {
  ok: "네, 올릴게요", cancel: "아니요",
  detail: "올리면 등록·일지·기록을 가족과 함께 볼 수 있어요. 집 주소는 이 폰에만 남아요. [아니요]를 고르면 이 폰에 따로 보관해요.",
  cancellable: false,
});

// ---------------------------------------------------------------- 셸 상태
let elders = [];
let mounted = false, mounting = null, reloading = false;
const quiet = new Set();
/** 설정 화면이 직접 빠지기·지우기를 했을 때: 그 어르신의 gone 안내·이동을 셸이 따로 하지 않게 */
export function expectGone(elderId) { if (elderId) quiet.add(elderId); }
/** 마지막으로 받은 내 어르신 목록 */
export const shellElders = () => elders.slice();

const within = (p, ms, fallback) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(t)); };
const roleText = (r) => (r === "owner" ? "관리자" : "가족");

function setBanner(id, text) {
  let b = document.getElementById(id);
  if (!text) { b?.remove(); return; }
  if (!b) { b = el("div", { id, class: "callout shell-banner", role: "status" }); const bar = $(".shellbar"); bar ? bar.after(b) : document.querySelector("main")?.prepend(b); }
  b.textContent = text;
}

function renderTabs(tab) {
  document.body.classList.add("has-tabs");
  if ($(".tabbar")) return;
  const nav = el("nav", { class: "tabbar", "aria-label": "주요 화면" },
    el("div", { class: "inner" }, TABS.map((t) => el("a", { href: t.href, class: `tab-${t.id}`, "aria-current": t.id === tab ? "page" : null },
      el("span", { class: "ic", "aria-hidden": "true" }, t.icon), el("span", { class: "lb" }, t.label)))));
  document.body.append(nav);
}

function renderBar(tab) {
  let bar = $(".shellbar");
  if (!bar) {
    bar = el("div", { class: "shellbar" });
    const main = document.querySelector("main") ?? document.body;
    main.prepend(bar);
  }
  bar.innerHTML = "";
  const cur = currentElder();
  const pick = el("button", { class: "elder-pick", type: "button", "aria-haspopup": "dialog", onclick: openSwitcher },
    el("span", { class: "muted" }, "어르신:"), " ", el("b", {}, cur ? cur.label || "어르신" : "고르기"), el("span", { "aria-hidden": "true" }, " ▾"));
  const gear = el("a", { class: "gear", href: "/settings", "aria-label": "설정", "aria-current": tab === "settings" ? "page" : null }, "⚙");
  bar.append(pick, gear);
}

function openSwitcher() {
  const cur = currentElder();
  const dlg = el("dialog", { class: "shell-dialog", "aria-labelledby": "sw-title" });
  const close = () => { dlg.close(); dlg.remove(); };
  const list = elders.length ? elders : cur ? [cur] : [];
  dlg.append(
    el("h2", { id: "sw-title", style: "margin-top:0" }, "어르신 고르기"),
    el("div", { class: "stack" },
      list.map((e) => el("button", { class: e.id === cur?.id ? "btn-primary elder-opt" : "btn-secondary elder-opt", "aria-current": e.id === cur?.id ? "true" : null,
        onclick: async () => {
          if (e.id === cur?.id) return close();
          close(); toast("어르신을 바꾸는 중…");
          await within(flush().catch(() => {}), WAIT_MS, null);   // 지금 어르신의 못 올린 변경부터
          setCurrentElder(e);
          location.reload();
        } }, el("span", {}, e.label || "어르신"), el("small", {}, e.id === cur?.id ? `지금 보는 중 · ${roleText(e.role)}` : roleText(e.role)))),
      el("button", { class: "btn-secondary", onclick: async () => {
        close();
        const e = await registerElder();
        if (!e) return;
        elders = [...elders.filter((x) => x.id !== e.id), e];
        await within(flush().catch(() => {}), WAIT_MS, null);
        setCurrentElder(e);
        location.reload();
      } }, "+ 새 어르신 등록"),
      el("button", { class: "btn-ghost", onclick: close }, "닫기")));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
}

function onSyncEvent(e) {
  if (e.type === "conflict") {
    toast(CONFLICT_TEXT);
    if (mounted && !reloading) { reloading = true; setTimeout(() => location.reload(), RELOAD_MS); }
  } else if (e.type === "gone") {
    elders = elders.filter((x) => x.id !== e.elderId);
    if (quiet.has(e.elderId)) return;
    toast(e.homeRemoved ? `${GONE_TEXT}. ${HOME_GONE_TEXT}.` : GONE_TEXT, 6000);
    if (!mounted) return;   // 시작하는 중이면 아래에서 다른 어르신을 고른다
    renderBar(currentTab);
    if (e.wasCurrent && !reloading) { reloading = true; setTimeout(() => location.assign("/"), RELOAD_MS); }
  } else if (e.type === "offline") setBanner("shell-pending", PENDING_TEXT);
  else if (e.type === "saved") setBanner("shell-pending", "");
  else if (e.type === "error") toast("이 변경은 서버가 받지 않았어요. 이 폰에는 남아 있어요.", 6000);
}

let currentTab = null;
/** 셸 붙이기. → Promise<{ elder: {id,label,role}|null, offline: boolean }> (한 화면에서 여러 번 불러도 한 번만 돈다) */
export function mountShell({ tab } = {}) {
  if (!mounting) mounting = start(tab);
  return mounting;
}

async function start(tab) {
  currentTab = tab ?? null;
  renderTabs(tab);
  renderBar(tab);
  onSync(onSyncEvent);
  installSync();

  const s = await session().catch(() => null);
  if (!s) {
    const st = storedSession();
    if (!st) { requireLogin(); return new Promise(() => {}); }   // 로그인 화면으로 가는 중
    // 로그인 정보는 있는데 갱신을 못 함 = 서버·네트워크 문제 → 이 폰의 마지막 사본으로
    checkAccount(st.user?.id);
    elders = await listElders().catch(() => []);
    if (!currentElder() && elders.length) setCurrentElder(elders[0]);
    renderBar(tab);
    setBanner("shell-offline", OFFLINE_TEXT);
    mounted = true;
    return { elder: currentElder(), offline: true };
  }

  checkAccount(s.user.id);
  let offline = false;
  if (currentElder()) {
    // 사본이 있으면 오래 기다리지 않는다. 늦게 온 목록은 고르기 창에 반영 (목록에 없는 어르신은 family.js 가 지우고 gone 으로 알린다)
    const lp = listElders().catch(() => null);
    const l = await within(lp, WAIT_MS, null);
    if (l) elders = l;
    else { elders = [currentElder()]; offline = true; lp.then((x) => { if (x) { elders = x; renderBar(tab); } }); }
  } else elders = await listElders().catch(() => []);

  if (!elders.length && !offline) {
    try {
      const r = await importLocalData({ elders, userId: s.user.id, ask: askImport });
      if (r?.ok) { elders = [{ id: r.elder.id, label: r.elder.label ?? "", role: r.elder.role ?? "owner" }]; if (r.message) toast(r.message, 8000); }
      else if (r && r.ok === false) toast(`이 폰의 등록 정보를 올리지 못했어요. ${errText(r.reason)}`, 6000);
    } catch {}
  }

  let res = "offline";
  for (let i = 0; i < 5; i++) {
    if (!elders.length) {
      const e = await registerElder({ required: true });
      if (!e) { res = "offline"; break; }   // 서버에 닿지 않아 건너뜀 — 고른 어르신 없이 계속
      elders = [e];
    }
    const cur = currentElder();
    const chosen = elders.find((x) => x.id === cur?.id) ?? elders[0];
    setCurrentElder(chosen);
    renderBar(tab);
    res = await within(pull().catch(() => "offline"), WAIT_MS, "offline");   // 늦으면 이 폰 사본으로 먼저 (pull 은 뒤에서 계속)
    if (res === "gone") { elders = elders.filter((x) => x.id !== chosen.id); continue; }
    break;
  }
  renderBar(tab);
  if (offline || res === "offline") setBanner("shell-offline", OFFLINE_TEXT);
  mounted = true;
  return { elder: currentElder(), offline: offline || res === "offline" };
}
