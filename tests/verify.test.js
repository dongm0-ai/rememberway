// public/lib/verify.js — flagHallucinations: every free-text field is checked against the guardian's words
import test from "node:test";
import assert from "node:assert/strict";
import { coerceClue, flagHallucinations } from "../public/lib/verify.js";

const clue = (over) => coerceClue({ ...over });

test("dementia_signs and prior_incidents absent from the utterance are flagged (a // comment used to swallow these two checks)", () => {
  const c = flagHallucinations(clue({ dementia_signs: "길을 자주 잃으심", prior_incidents: "작년 겨울에 실종" }), "아버지가 베이지색 점퍼를 입고 나가셨어요", "");
  assert.equal(c.flags.dementia_signs, "unverified");
  assert.equal(c.flags.prior_incidents, "unverified");
});
test("dementia_signs and prior_incidents found in the utterance are not flagged", () => {
  const c = flagHallucinations(clue({ dementia_signs: "길을 잃으세요", prior_incidents: "전에도 있었음" }), "요즘 길을 자꾸 잃으세요. 전에도 한 번 나가셨어요", "");
  assert.equal(c.flags.dementia_signs, undefined);
  assert.equal(c.flags.prior_incidents, undefined);
});
test("registered info counts as a source for these two fields too", () => {
  const c = flagHallucinations(clue({ dementia_signs: "길을 잃으세요" }), "점퍼를 입고 나가셨어요", "평소: 길을 자주 잃으세요");
  assert.equal(c.flags.dementia_signs, undefined);
});
test("the checks that were already running still run (gait, meds)", () => {
  const c = flagHallucinations(clue({ gait: "다리를 저심", meds: "복용 중" }), "점퍼를 입고 나가셨어요", "");
  assert.equal(c.flags.gait, "unverified");
  assert.equal(c.flags.meds, "unverified");
});
