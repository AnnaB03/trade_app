import { test } from "node:test";
import assert from "node:assert/strict";
const a = await import("../app/api/agentsLib.js");

const keys = (runs) => runs.map((r) => `${r.role}|${r.mode}`);

test("the morning brief runs from 8:45, once", () => {
  assert.deepEqual(keys(a.dueRuns({ nowMin: 8 * 60 + 44, dow: 3 })), []);
  const at = a.dueRuns({ nowMin: 8 * 60 + 45, dow: 3 });
  assert.deepEqual(keys(at), ["risk-market-analyst|brief"]);
  assert.deepEqual(keys(a.dueRuns({ nowMin: 8 * 60 + 50, dow: 3, done: new Set([at[0].key]) })), [], "not twice");
  assert.deepEqual(keys(a.dueRuns({ nowMin: 9 * 60 + 40, dow: 3 })), ["risk-market-analyst|brief"], "a brief missed while the Mac slept still runs before 11:00");
  assert.deepEqual(keys(a.dueRuns({ nowMin: 11 * 60 + 1, dow: 3 })), [], "after 11:00 it is no longer a brief");
});

test("midday, then QA and the performance report after the close; weekly on Friday; they catch up until midnight", () => {
  assert.deepEqual(keys(a.dueRuns({ nowMin: 21 * 60, dow: 2 })), ["qa|daily", "performance-analyst|daily"], "the Mac woke at 21:00: both still run");
  assert.deepEqual(keys(a.dueRuns({ nowMin: 12 * 60 + 31, dow: 2 })), ["risk-market-analyst|midday"]);
  assert.deepEqual(keys(a.dueRuns({ nowMin: 16 * 60 + 40, dow: 2 })), ["qa|daily", "performance-analyst|daily"]);
  assert.deepEqual(keys(a.dueRuns({ nowMin: 16 * 60 + 40, dow: 5 })), ["qa|daily", "performance-analyst|weekly"]);
  assert.deepEqual(a.dueRuns({ nowMin: 16 * 60 + 40, dow: 6 }), [], "no weekend runs");
});

test("a big release gets a read 15 minutes after it; a pre-market one is the brief's job; small ones are skipped", () => {
  const macro = [
    { label: "Inflation Rate YoY (Sep)", timeET: "8:30 AM" },
    { label: "Core Inflation Rate MoM (Sep)", timeET: "8:30 AM" },
    { label: "Fed Interest Rate Decision", timeET: "2:00 PM" },
    { label: "FOMC Press Conference", timeET: "2:30 PM" },
    { label: "Fed Barkin Speech", timeET: "1:30 PM" },
  ];
  assert.deepEqual(a.eventSlots(macro).map((e) => [e.slot, e.labels.length]), [[14 * 60 + 15, 1], [14 * 60 + 45, 1]]);
  const due = a.dueRuns({ nowMin: 14 * 60 + 16, dow: 3, macroToday: macro });
  assert.deepEqual(keys(due), ["risk-market-analyst|event"]);
  assert.match(a.taskPrompt({ ...due[0], dateET: "2026-10-14", timeET: "14:16" }), /Fed Interest Rate Decision/);
});

test("a daily cap on runs, as a cost guard", () => {
  assert.deepEqual(a.dueRuns({ nowMin: 8 * 60 + 45, dow: 1, runsToday: a.MAX_RUNS_PER_DAY }), []);
});

test("agents are read-only: no Edit or Write, Bash limited to reading commands, web only for the market analyst", () => {
  for (const role of Object.keys(a.ROLES)) {
    const t = a.allowedTools(role);
    assert.ok(!t.includes("Edit") && !t.includes("Write"), role);
    assert.ok(t.filter((x) => x.startsWith("Bash")).every((x) => /^Bash\((npm test|sqlite3|python3|curl|git (log|diff|show)|grep|tail|head|cat|ls|date|wc|jq):\*\)$/.test(x)), role);
  }
  assert.deepEqual(a.DISALLOWED_TOOLS, ["Edit", "Write", "NotebookEdit"]);
  assert.ok(a.allowedTools("risk-market-analyst").includes("WebSearch"));
  assert.ok(!a.allowedTools("qa").includes("WebSearch"));
});

test("only ALERT: lines reach the phone", () => {
  const text = "QA — 2026-10-14\nAll healthy.\nALERT: fades priced at yesterday's option price\n- **ALERT:** the 8/day cap counts unfilled orders\nnot an alert";
  assert.deepEqual(a.alertsIn(text), ["fades priced at yesterday's option price", "the 8/day cap counts unfilled orders"]);
  assert.deepEqual(a.alertsIn("nothing to see"), []);
});

test("report file names sort by time and round-trip", () => {
  assert.equal(a.reportName({ dateET: "2026-10-15", timeET: "08:45", role: "risk-market-analyst", mode: "brief" }), "2026-10-15_0845_risk-market-analyst_brief.md");
});
