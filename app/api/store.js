/* ---------- SQLite persistence, two collections ----------
   1. Ideas ledger — every AI suggestion, graded later against what the
      price actually did (see gradeLib.js).
   2. Trade journal — every REAL order this app placed, from open to close,
      with the plan and the reason for closing. See journalLib.js.
   Plus a small key/value table for state that has to survive a restart and
   be visible to every route at once (the trading halt, see riskLib.js).

   This replaced two JSON files on 2026-10-13. The files were rewritten whole
   on every append (read all, push, write all) by a server that the launchd
   schedule now hits from three jobs at once, and writeFileSync is not atomic:
   a crash or a second writer mid-write leaves a truncated file, readAll()
   turns that into [] on the next parse error, and the following append
   writes a one-row file over the whole history. SQLite gives one writer at a
   time, an atomic update, and a file that survives a crash.

   Rows stay schema-less: each is one JSON document keyed by id, so every
   caller's list/append/update/find contract is unchanged and a new field
   needs no migration. Uses Node's built-in sqlite (22.13+), reached through
   process.getBuiltinModule so the Next.js bundler leaves it alone.

   The old data/ideas.json and data/journal.json are imported once, the first
   time the database is opened with an empty table, and renamed *.migrated.
   Nothing is deleted. STORE_FILE overrides the database path (tests). */
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const DB_FILE = process.env.STORE_FILE || path.join(DIR, "cockpit.db");

let db = null;
function open() {
  if (db) return db;
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite) throw new Error("This Node version has no built-in sqlite (need 22.13+); see app/api/store.js");
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new sqlite.DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  for (const t of ["ideas", "journal"]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, data TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS ${t}_createdAt ON ${t}(createdAt);`);
  }
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);");
  migrateJson("ideas", "ideas.json");
  migrateJson("journal", "journal.json");
  return db;
}

// One-time import of the JSON-file store this replaced. Only into an empty
// table, so a database that already has rows is never touched by stale files.
function migrateJson(table, filename) {
  const file = path.join(DIR, filename);
  if (!fs.existsSync(file)) return;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  if (count > 0) return;
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, "utf8") || "[]"); } catch (e) {
    console.warn(`[store] ${filename} is not valid JSON — left in place, not imported (${e.message})`);
    return;
  }
  if (!Array.isArray(rows)) return;
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (id, createdAt, data) VALUES (?, ?, ?)`);
  const tx = () => { for (const r of rows) if (r && r.id) ins.run(String(r.id), String(r.createdAt || ""), JSON.stringify(r)); };
  db.exec("BEGIN"); try { tx(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  try { fs.renameSync(file, file + ".migrated"); } catch {}
  console.log(`[store] imported ${rows.length} rows from ${filename} into sqlite`);
}

function collection(table) {
  const parse = (r) => JSON.parse(r.data);
  return {
    // Newest first, as the JSON store sorted.
    list: () => open().prepare(`SELECT data FROM ${table} ORDER BY createdAt DESC, rowid DESC`).all().map(parse),
    append: (data, extra = {}) => {
      const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), ...extra, ...data };
      open().prepare(`INSERT INTO ${table} (id, createdAt, data) VALUES (?, ?, ?)`).run(row.id, row.createdAt, JSON.stringify(row));
      return row;
    },
    // Read-merge-write inside one transaction, so two routes patching the
    // same row (autoexit's peakMark, reconcile's fill price) cannot lose
    // each other's fields.
    update: (id, patch) => {
      const d = open();
      d.exec("BEGIN IMMEDIATE");
      try {
        const cur = d.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id));
        if (!cur) { d.exec("COMMIT"); return null; }
        const next = { ...parse(cur), ...patch, updatedAt: new Date().toISOString() };
        d.prepare(`UPDATE ${table} SET data = ?, createdAt = ? WHERE id = ?`).run(JSON.stringify(next), String(next.createdAt || ""), String(id));
        d.exec("COMMIT");
        return next;
      } catch (e) { d.exec("ROLLBACK"); throw e; }
    },
    find: (pred) => {
      for (const r of open().prepare(`SELECT data FROM ${table} ORDER BY createdAt DESC, rowid DESC`).iterate()) {
        const row = parse(r);
        if (pred(row)) return row;
      }
      return null;
    },
  };
}

/* ---------- Ideas ledger ---------- */
const ideasStore = collection("ideas");
export const listIdeas = ideasStore.list;
export const appendIdea = (idea) => ideasStore.append(idea, { grades: {} });
export const appendIdeas = (ideas) => ideas.map(appendIdea);
export const updateIdea = (id, patch) => ideasStore.update(id, patch);

// Ideas that are due for a grading checkpoint they don't have yet.
// checkpoints: [{ key, afterMs }] — e.g. { key: "h1", afterMs: 3600000 }
export function dueForGrading(checkpoints, now = Date.now()) {
  return listIdeas().filter((idea) => {
    if (!["CALL", "PUT", "BUY", "SELL"].includes(idea.action)) return false;
    const age = now - new Date(idea.createdAt).getTime();
    return checkpoints.some((cp) => age >= cp.afterMs && !idea.grades?.[cp.key]);
  });
}

/* ---------- Trade journal (real placed orders, open -> close) ---------- */
const journalStore = collection("journal");
export const listJournal = journalStore.list;
export const appendJournalEntry = (entry) => journalStore.append(entry, { status: "open" });
export const updateJournalEntry = (id, patch) => journalStore.update(id, patch);
export const findOpenJournalEntry = (pred) => journalStore.find((r) => r.status === "open" && pred(r));

/* ---------- Key/value state ---------- */
export function kvGet(key) {
  const r = open().prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return r ? JSON.parse(r.value) : null;
}
export function kvSet(key, value) {
  open().prepare("INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt")
    .run(key, JSON.stringify(value), new Date().toISOString());
  return value;
}
export function kvDelete(key) { open().prepare("DELETE FROM kv WHERE key = ?").run(key); }

// Tests only: close the handle so a temp database file can be removed.
export function _closeForTests() { if (db) { db.close(); db = null; } }
