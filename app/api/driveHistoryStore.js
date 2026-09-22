/* ---------- Per-symbol opening-drive history ----------
   Keeps the last ~40 sessions' first-30-minute (%) move per symbol, so
   openingDriveLib.js can compare today's drive to that symbol's own
   typical size instead of a flat guess. Same JSON-file pattern and the
   same read-only-filesystem caveat as app/api/store.js (data/*.json,
   gitignored, no-ops on Vercel — degrades to the flat-default fallback
   in that case, it does not throw). */
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "driveHistory.json");
const KEEP = 40;
let warned = false;
const warnOnce = (action, e) => {
  if (warned) return;
  warned = true;
  console.warn(`[driveHistoryStore] ${action} failed — unavailable this run (${e.message}). ` +
    `Opening-drive "typical" size falls back to a flat default. See app/api/driveHistoryStore.js.`);
};

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    warnOnce("read", e);
    return {};
  }
}

function writeAll(data) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    warnOnce("write", e);
  }
}

// Last N |drivePct| samples for a symbol, oldest first — the median of these
// is the "typical" move openingDriveLib compares today's drive against.
export function driveHistoryFor(symbol) {
  const all = readAll();
  return Array.isArray(all[symbol]) ? all[symbol] : [];
}

// Record today's resolved (non-pending, non-n/a) drive for a symbol. Safe to
// call more than once for the same date — de-duped by date, last write wins.
export function recordDrive(symbol, date, drivePct) {
  if (!symbol || !date || drivePct == null || !Number.isFinite(drivePct)) return;
  const all = readAll();
  const rows = Array.isArray(all[symbol]) ? all[symbol].filter((r) => r.date !== date) : [];
  rows.push({ date, drivePct });
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  all[symbol] = rows.slice(-KEEP);
  writeAll(all);
}

// Median absolute drive over the stored history, or null with too few samples
// (openingDriveLib decides the fallback in that case).
export function medianAbsDrive(symbol, { minSamples = 5 } = {}) {
  const rows = driveHistoryFor(symbol);
  if (rows.length < minSamples) return null;
  const abs = rows.map((r) => Math.abs(r.drivePct)).sort((a, b) => a - b);
  const mid = Math.floor(abs.length / 2);
  return abs.length % 2 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
}
