import { test } from "node:test";
import assert from "node:assert/strict";
const sel = await import("../app/api/selectionLib.js");
const v = (o) => sel.selectionVerdict({ etMinutes: 10 * 60, ...o });

test("the two losing regime buckets are faded, not merely skipped", () => {
  const up = v({ action: "CALL", regime: "uptrend" });
  assert.deepEqual([up.ok, up.fade, up.rule], [false, true, "regime"]);
  assert.equal(v({ action: "BUY", regime: "uptrend" }).fade, true, "share buys count as bullish");
  const tr = v({ action: "PUT", regime: "transitioning" });
  assert.deepEqual([tr.ok, tr.fade, tr.rule], [false, true, "regime"]);
});

test("the winning buckets trade as written", () => {
  assert.equal(v({ action: "PUT", regime: "uptrend" }).ok, true, "+1.60R an hour later");
  assert.equal(v({ action: "CALL", regime: "transitioning" }).ok, true, "+1.24R an hour later");
  assert.equal(v({ action: "CALL", regime: "mixed / range" }).ok, true);
  assert.equal(v({ action: "PUT", regime: "mixed / range" }).ok, true);
  assert.equal(v({ action: "CALL", regime: "downtrend" }).ok, true, "no evidence either way, so no rule");
  assert.equal(v({ action: "WAIT", regime: "uptrend" }).ok, true);
});

test("bullish ideas stop at 14:00 ET; bearish ones do not", () => {
  const late = v({ action: "CALL", regime: "mixed / range", etMinutes: 14 * 60 });
  assert.deepEqual([late.ok, late.fade, late.rule], [false, false, "late_call"]);
  assert.equal(v({ action: "CALL", regime: "mixed / range", etMinutes: 13 * 60 + 59 }).ok, true);
  assert.equal(v({ action: "PUT", regime: "mixed / range", etMinutes: 15 * 60 }).ok, true);
});

test("a clinical/FDA catalyst is refused outright, whatever the regime", () => {
  const c = v({ action: "PUT", regime: "uptrend", catalyst: "clinical/FDA" });
  assert.deepEqual([c.ok, c.fade, c.rule], [false, false, "catalyst"]);
  assert.equal(v({ action: "CALL", regime: "transitioning", catalyst: "FDA approval" }).ok, false);
});

test("SELECTION_RULES=off restores the old behaviour", () => {
  process.env.SELECTION_RULES = "off";
  assert.deepEqual(sel.selectionVerdict({ action: "CALL", regime: "uptrend", etMinutes: 900 }), { ok: true, fade: false });
  delete process.env.SELECTION_RULES;
});
