/* ---------- Self-pruning "extras" watchlist ----------
   The permanent core (SPY/SPX/QQQ/NVDA/TSLA/AMD, in page.js's DEFAULT_SYMS)
   never changes. This is for the OTHER kind of addition — "check out MU",
   "my traders bought RKLB today" — which has a real shelf life: the reason
   it was interesting (an earnings date, a contract win, a squeeze) fades,
   and a list that only ever grows eventually reproduces the exact "list is
   too long" slowdown that was already fixed once by capping the auto-
   discovered movers pool. The fix there was bounding + auto-refresh, not
   just a bigger cap — this applies the same idea to manually-added names:
   a fixed-size slot list where the STALEST entry (not the oldest) gets
   evicted to make room, and a daily sweep drops anything that's gone
   quiet even without needing the room. */
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "watchExtras.json");
const MAX_EXTRAS = 6;
// A symbol is stale once it's gone this many days with no notable idea
// (non-WAIT, conviction >=4, or a big % move) AND has been on the list at
// least that long — the grace period keeps a same-day addition from being
// swept before it's had a real chance to show anything.
const STALE_DAYS = 5;

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeAll(rows) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function listExtras() {
  return readAll();
}

// Add (or refresh) a symbol. If already present, just touches lastNotableAt
// so re-adding something you're still interested in resets its clock. If
// the list is at capacity, evicts whichever entry has gone longest without
// a notable idea (see touchNotable) — not simply the oldest addition, so a
// name that's still actively producing real setups never gets bumped for
// one that's been quietly sitting at WAIT.
export function addExtra(symbol, reason) {
  const sym = symbol.toUpperCase();
  const rows = readAll();
  const now = new Date().toISOString();
  const existing = rows.find((r) => r.symbol === sym);
  if (existing) {
    existing.lastNotableAt = now;
    writeAll(rows);
    return { added: false, refreshed: true, evicted: null, extras: rows };
  }
  let evicted = null;
  if (rows.length >= MAX_EXTRAS) {
    rows.sort((a, b) => new Date(a.lastNotableAt) - new Date(b.lastNotableAt));
    evicted = rows.shift();
  }
  rows.push({ symbol: sym, addedAt: now, lastNotableAt: now, reason: reason || null });
  writeAll(rows);
  return { added: true, refreshed: false, evicted, extras: rows };
}

export function removeExtra(symbol) {
  const sym = symbol.toUpperCase();
  const rows = readAll().filter((r) => r.symbol !== sym);
  writeAll(rows);
  return rows;
}

// Called from the suggestions route for every extras-list idea it
// generates — a non-WAIT action, high conviction, or a big move all count
// as "still worth the slot," resetting the staleness clock regardless of
// whether anything was actually tradeable that check.
export function touchNotable(symbol) {
  const sym = symbol.toUpperCase();
  const rows = readAll();
  const row = rows.find((r) => r.symbol === sym);
  if (!row) return false;
  row.lastNotableAt = new Date().toISOString();
  writeAll(rows);
  return true;
}

export function isNotable(idea) {
  return idea.action !== "WAIT" || Number(idea.conviction) >= 4 || (idea.todayChangePct != null && Math.abs(idea.todayChangePct) >= 10);
}

// Daily sweep: drop anything that's gone STALE_DAYS with nothing notable
// AND has been on the list at least that long. Returns what got dropped so
// a caller can report it plainly rather than silently rewriting the list.
export function pruneStale() {
  const rows = readAll();
  const now = Date.now();
  const cutoff = STALE_DAYS * 86400000;
  const kept = [], dropped = [];
  for (const r of rows) {
    const sinceNotable = now - new Date(r.lastNotableAt).getTime();
    const sinceAdded = now - new Date(r.addedAt).getTime();
    if (sinceNotable >= cutoff && sinceAdded >= cutoff) dropped.push(r);
    else kept.push(r);
  }
  if (dropped.length) writeAll(kept);
  return { kept, dropped };
}
