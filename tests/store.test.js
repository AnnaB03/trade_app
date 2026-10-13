import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The store reads STORE_FILE at import time, so point it at a temp database
   before importing. Migration reads data/*.json relative to cwd — that is
   covered by running the import in a temp cwd below. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-store-"));
process.env.STORE_FILE = path.join(tmp, "test.db");
const store = await import("../app/api/store.js");

after(() => { store._closeForTests(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("append / list round-trips a schema-less row, newest first", () => {
  const a = store.appendIdea({ symbol: "NVDA", action: "CALL", conviction: 3 });
  const b = store.appendIdea({ symbol: "SPY", action: "WAIT" });
  assert.ok(a.id && a.createdAt);
  assert.deepEqual(a.grades, {}, "appendIdea seeds grades");
  const rows = store.listIdeas();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, b.id, "newest first");
  assert.equal(rows[1].symbol, "NVDA");
});

test("update merges a patch and keeps every other field", () => {
  const row = store.appendJournalEntry({ symbol: "INTC", vehicle: "OPTION", entryQuantity: 4 });
  assert.equal(row.status, "open");
  const next = store.updateJournalEntry(row.id, { peakMark: 2.5 });
  assert.equal(next.peakMark, 2.5);
  assert.equal(next.entryQuantity, 4);
  assert.ok(next.updatedAt);
  const again = store.updateJournalEntry(row.id, { entryFillPrice: 2.01 });
  assert.equal(again.peakMark, 2.5, "a second patch does not drop the first");
  assert.equal(store.updateJournalEntry("no-such-id", { x: 1 }), null);
});

test("findOpenJournalEntry sees only open rows", () => {
  const row = store.appendJournalEntry({ symbol: "AMD", vehicle: "SHARES" });
  assert.equal(store.findOpenJournalEntry((r) => r.symbol === "AMD").id, row.id);
  store.updateJournalEntry(row.id, { status: "closed" });
  assert.equal(store.findOpenJournalEntry((r) => r.symbol === "AMD"), null);
});

test("kv: set, get, overwrite, delete", () => {
  assert.equal(store.kvGet("halt"), null);
  store.kvSet("halt", { halted: true, reason: "manual" });
  assert.deepEqual(store.kvGet("halt"), { halted: true, reason: "manual" });
  store.kvSet("halt", { halted: false });
  assert.deepEqual(store.kvGet("halt"), { halted: false });
  store.kvDelete("halt");
  assert.equal(store.kvGet("halt"), null);
});

test("dueForGrading picks directional ideas missing a checkpoint", () => {
  const old = store.appendIdea({ symbol: "MU", action: "PUT" });
  store.updateIdea(old.id, { createdAt: new Date(Date.now() - 2 * 3600000).toISOString() });
  const due = store.dueForGrading([{ key: "h1", afterMs: 3600000 }]);
  assert.ok(due.some((i) => i.id === old.id));
  store.updateIdea(old.id, { grades: { h1: { correct: true } } });
  assert.ok(!store.dueForGrading([{ key: "h1", afterMs: 3600000 }]).some((i) => i.id === old.id));
});

test("first open imports the legacy JSON files once and renames them", async () => {
  // A separate process, because the store caches its handle and its path.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-migrate-"));
  fs.mkdirSync(path.join(cwd, "data"));
  fs.writeFileSync(path.join(cwd, "data", "ideas.json"), JSON.stringify([
    { id: "i1", createdAt: "2026-10-01T14:00:00Z", symbol: "NVDA", action: "CALL", grades: {} },
    { id: "i2", createdAt: "2026-10-02T14:00:00Z", symbol: "SPY", action: "WAIT", grades: {} },
  ]));
  fs.writeFileSync(path.join(cwd, "data", "journal.json"), JSON.stringify([
    { id: "j1", createdAt: "2026-10-01T14:05:00Z", symbol: "NVDA", status: "closed", pnl: 396 },
  ]));
  const { execFileSync } = await import("node:child_process");
  const script = `
    const s = await import(${JSON.stringify(path.resolve("app/api/store.js"))});
    const ideas = s.listIdeas(); const journal = s.listJournal();
    console.log(JSON.stringify({ ideas: ideas.map(i => i.id), journal: journal.map(j => j.pnl) }));
    s._closeForTests();`;
  const run = () => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    cwd, env: { ...process.env, STORE_FILE: path.join(cwd, "data", "cockpit.db") }, encoding: "utf8",
  }).trim().split("\n").pop());
  const first = run();
  assert.deepEqual(first, { ideas: ["i2", "i1"], journal: [396] });
  assert.ok(fs.existsSync(path.join(cwd, "data", "ideas.json.migrated")), "source file renamed, not deleted");
  assert.ok(!fs.existsSync(path.join(cwd, "data", "ideas.json")));
  // Put a stale file back: a populated table is never re-imported.
  fs.writeFileSync(path.join(cwd, "data", "ideas.json"), JSON.stringify([{ id: "stale", createdAt: "2026-01-01T00:00:00Z" }]));
  const second = run();
  assert.deepEqual(second.ideas, ["i2", "i1"]);
  fs.rmSync(cwd, { recursive: true, force: true });
});
