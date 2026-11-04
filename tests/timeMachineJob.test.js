import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const tm = await import("../app/api/timeMachineJob.js");

test("Time Machine record: once a weekday after 16:10, never during the session — 2026-11-04, 'lets record odds on every trade'", () => {
  assert.equal(tm.TIME_MACHINE_MIN, 16 * 60 + 10);
  assert.equal(tm.timeMachineDue({ nowMin: 16 * 60 + 9, dow: 3, saved: false }), false, "not before 16:10");
  assert.equal(tm.timeMachineDue({ nowMin: 16 * 60 + 10, dow: 3, saved: false }), true);
  assert.equal(tm.timeMachineDue({ nowMin: 23 * 60, dow: 3, saved: false }), true, "a missed run catches up the same evening");
  assert.equal(tm.timeMachineDue({ nowMin: 16 * 60 + 30, dow: 3, saved: true }), false, "once a day");
  assert.equal(tm.timeMachineDue({ nowMin: 17 * 60, dow: 6, saved: false }), false, "weekdays only");
});

test("Time Machine record only records: the job never imports trading code", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/api/timeMachineJob.js"), "utf8");
  assert.doesNotMatch(src, /from "\.\.?\/(order|store|tradier|sim)/, "no trading, journal or broker imports");
  assert.match(src, /timemachine\.py", "journal", dateET, "--save"/);
});
