// 지도 표식 HTML 이스케이프 — 가족이 적은 장소 이름이 Marker icon.content 에 HTML로 들어가도 태그가 되지 않아야 한다
import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, pinHtml, labelHtml } from "../public/js/map.js";

const EVIL = `x"><img src=x onerror=alert(1)>`;

test("escapeHtml: 따옴표·꺾쇠·& 를 엔티티로", () => {
  assert.equal(escapeHtml(EVIL), "x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(escapeHtml(`a&b'c\`d`), "a&amp;b&#39;c&#96;d");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(12), "12");
  assert.equal(escapeHtml("옛 직장"), "옛 직장");
});

test("pinHtml: 이름이 title 속성을 깨고 나오지 않는다", () => {
  const h = pinHtml({ name: EVIL, pin: "1" }, 0);
  assert.ok(!h.includes("<img"), h);
  assert.ok(h.includes('title="x&quot;&gt;&lt;img'), h);
  assert.equal((h.match(/</g) || []).length, 2);   // <div ...> 와 </div> 뿐
});

test("pinHtml: 핀 글자(c.pin)도 이스케이프", () => {
  assert.ok(!pinHtml({ name: "a", pin: "<b>" }, 0).includes("<b>"));
});

test("labelHtml: 이름표 글이 태그가 되지 않는다", () => {
  const h = labelHtml({ name: EVIL }, 0, EVIL);
  assert.ok(!h.includes("<img"), h);
  assert.equal((h.match(/</g) || []).length, 2);
});
