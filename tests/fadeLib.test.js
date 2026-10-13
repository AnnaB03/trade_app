import { test } from "node:test";
import assert from "node:assert/strict";
const fade = await import("../app/api/fadeLib.js");

test("rangePosition: where the price sits between the day's low and high", () => {
  assert.equal(fade.rangePosition(110, 100, 120), 50);
  assert.equal(fade.rangePosition(120, 100, 120), 100);
  assert.equal(fade.rangePosition(100, 100, 120), 0);
  assert.equal(fade.rangePosition(130, 100, 120), 100, "clamped, never past the ends");
  assert.equal(fade.rangePosition(110, 100, 100), null, "no range, no answer");
  assert.equal(fade.rangePosition(0, 100, 120), null);
});

test("extremeRead: a call at the high and a put at the low are both extreme", () => {
  assert.deepEqual(fade.extremeRead({ action: "CALL", price: 119, low: 100, high: 120 }), { pos: 95, atExtreme: true, side: "long" });
  assert.equal(fade.extremeRead({ action: "BUY", price: 110, low: 100, high: 120 }).atExtreme, false, "mid-range is not extreme");
  assert.equal(fade.extremeRead({ action: "PUT", price: 101, low: 100, high: 120 }).atExtreme, true);
  assert.equal(fade.extremeRead({ action: "PUT", price: 119, low: 100, high: 120 }).atExtreme, false, "a put at the HIGH is not chasing");
  assert.equal(fade.extremeRead({ action: "CALL", price: 119, low: 100, high: 120, threshold: 99 }).atExtreme, false, "threshold is honoured");
});

test("fadePlan: the opposite side, with levels set from the risk", () => {
  // At the exact high of a 100-120 range: stop 10% of the range above it.
  const p = fade.fadePlan({ action: "CALL", price: 120, low: 100, high: 120 });
  assert.equal(p.action, "PUT");
  assert.equal(p.optionType, "put");
  assert.equal(p.invalidation, 122, "a short way beyond the high being chased");
  assert.equal(p.riskUsd, 2);
  assert.equal(p.target, 116.4, "1.8x the risk back into the range");
  assert.equal(p.rewardRisk, 1.8);
  assert.equal(fade.fadePlan({ action: "CALL", price: 110, low: 100, high: 120 }), null, "not at the extreme, no fade");
  assert.equal(fade.fadePlan({ action: "WAIT", price: 120, low: 100, high: 120 }), null);
});

test("fadePlan: the geometry holds short of the extreme, where 1.5:1 is the floor", () => {
  // 85% of the range is the threshold itself, and the weakest case: the stop
  // has to clear the high as well as the distance from it.
  const p = fade.fadePlan({ action: "BUY", price: 117, low: 100, high: 120 });
  assert.equal(p.rangePos, 85);
  assert.equal(p.invalidation, 122);
  assert.equal(p.riskUsd, 5, "3 to the high plus a 2 buffer");
  assert.equal(p.target, 108, "still 1.8x the risk, so autotrade's 1.5:1 floor passes");
  assert.ok(Math.abs(p.target - 117) / Math.abs(p.invalidation - 117) >= 1.5);
});

test("fadePlan: only the long side is flipped by default", () => {
  assert.equal(fade.FADE_SIDES, "long");
  assert.equal(fade.fadeEnabled("long"), true);
  assert.equal(fade.fadeEnabled("short"), false, "puts at the day's low are the record's only winning pattern");
  assert.equal(fade.fadePlan({ action: "PUT", price: 100, low: 100, high: 120 }), null);
});

test("the fade's exits: same-day target on the live price, and no thesis-reversed rule", async () => {
  const { decideLevelExit, decideReversalExit, SAME_DAY_STRATEGIES } = await import("../app/api/order/exitRules.js");
  assert.ok(SAME_DAY_STRATEGIES.has("contrarian"));
  // A fade of a CALL is a PUT: dir -1, target BELOW. The day's low is already
  // through the target (the range is why the fade was taken), so only the live
  // price may trigger it.
  const base = { dir: -1, target: 112, invalidation: 125, underlyingPx: 118, favorableExtreme: 100 };
  assert.equal(decideLevelExit({ ...base, strategy: "swing" })?.tag, "target", "a multi-day position reads the day's extreme");
  assert.equal(decideLevelExit({ ...base, strategy: "contrarian" }), null, "the fade waits for the live price");
  assert.equal(decideLevelExit({ ...base, strategy: "contrarian", underlyingPx: 111 })?.tag, "target");
  // The bullish idea it was faded from must not close it.
  // The bullish read has to POSTDATE the position's own thesis to count.
  const ideas = [{ id: "bull", symbol: "NVDA", action: "CALL", createdAt: new Date().toISOString(), why_plain: "breaking out" }];
  const pos = { symbol: "NVDA", ideaId: "fade", createdAt: new Date(Date.now() - 5 * 60000).toISOString() };
  assert.equal(decideReversalExit({ pos: { ...pos, strategy: "swing" }, dir: -1, ideas })?.tag, "reversed");
  assert.equal(decideReversalExit({ pos: { ...pos, strategy: "contrarian" }, dir: -1, ideas }), null);
});
