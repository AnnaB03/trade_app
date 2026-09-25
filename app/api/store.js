/* ---------- JSON-file persistence, two collections ----------
   1. Ideas ledger (ideas.json) — every AI suggestion, graded later against
      what the price actually did (see gradeLib.js).
   2. Trade journal (journal.json) — every REAL order this app placed into
      the Tradier sandbox, from open to close, with the plan and the reason
      for closing. See journalLib.js.

   LOCAL-DEV STORE: writes to ./data/*.json (gitignored). This works for
   `next dev` / `next start` on a machine you control, where the filesystem
   is real and persistent between requests.

   ON VERCEL (or any read-only-fs serverless host) writes will fail — the
   project directory is read-only in production there. Failures are caught
   and logged; the app degrades to "no memory this run" rather than crashing.
   Swap this module for a real store (Vercel KV, Postgres, SQLite on a
   mounted volume, etc.) before relying on either collection in that
   environment — list/append/update is the whole contract to keep. */
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");

function fileStore(filename) {
  const FILE = path.join(DIR, filename);
  let warned = false;
  const warnOnce = (action, e) => {
    if (warned) return;
    warned = true;
    console.warn(`[store] ${action} on ${filename} failed — unavailable this run (${e.message}). ` +
      `Likely a read-only filesystem (e.g. Vercel production). See app/api/store.js.`);
  };
  const readAll = () => {
    try {
      if (!fs.existsSync(FILE)) return [];
      const parsed = JSON.parse(fs.readFileSync(FILE, "utf8") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      warnOnce("read", e);
      return [];
    }
  };
  const writeAll = (rows) => {
    try {
      if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
      return true;
    } catch (e) {
      warnOnce("write", e);
      return false;
    }
  };
  return {
    list: () => readAll().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    append: (data, extra = {}) => {
      const rows = readAll();
      const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), ...extra, ...data };
      rows.push(row);
      writeAll(rows);
      return row;
    },
    update: (id, patch) => {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === id);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
      writeAll(rows);
      return rows[i];
    },
    find: (pred) => readAll().find(pred) ?? null,
  };
}

/* ---------- Ideas ledger ---------- */
const ideasStore = fileStore("ideas.json");
export const listIdeas = ideasStore.list;
export const appendIdea = (idea) => ideasStore.append(idea, { grades: {} });
export const appendIdeas = (ideas) => ideas.map(appendIdea);
export const updateIdea = (id, patch) => ideasStore.update(id, patch);

// Ideas that are due for a grading checkpoint they don't have yet.
// checkpoints: [{ key, afterMs }] — e.g. { key: "h1", afterMs: 3600000 }
export function dueForGrading(checkpoints, now = Date.now()) {
  return listIdeas().filter((idea) => {
    if (!["CALL", "PUT", "BUY", "SELL"].includes(idea.action) || idea.pendingFill || idea.unfilled) return false;
    const age = now - new Date(idea.gradeFrom || idea.createdAt).getTime();
    return checkpoints.some((cp) => age >= cp.afterMs && !idea.grades?.[cp.key]);
  });
}

/* ---------- Trade journal (real placed orders, open -> close) ---------- */
const journalStore = fileStore("journal.json");
export const listJournal = journalStore.list;
export const appendJournalEntry = (entry) => journalStore.append(entry, { status: "open" });
export const updateJournalEntry = (id, patch) => journalStore.update(id, patch);
export const findOpenJournalEntry = (pred) => journalStore.find((r) => r.status === "open" && pred(r));
