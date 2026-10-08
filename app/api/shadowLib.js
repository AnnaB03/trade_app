/* Watch-only trades: what a playbook WOULD have bought, recorded without
   touching the account.

   Added 2026-10-08 after the same-day playbook was switched on live the same
   morning it was written and lost money through an entry bug nobody had seen
   it make. A new kind of trade now has to show its entries here first. Each
   row is one would-be entry, taken at the same moment and through the same
   gates as a real one; scripts/shadow-report.py works out afterwards how each
   would have ended. Nothing here is read by the order path. */
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "shadow.json");
const SAME_SETUP_MIN = 45; // mirrors the live path's refusal to re-buy a just-traded setup

function readAll() {
  try { const r = JSON.parse(fs.readFileSync(FILE, "utf8")); return Array.isArray(r) ? r : []; } catch { return []; }
}

// Returns the new row, or null when this idea (or the same setup, minutes ago)
// is already recorded.
export function recordShadowEntry(row) {
  const rows = readAll();
  const now = Date.now();
  const dup = rows.find((r) => r.ideaId === row.ideaId ||
    (r.symbol === row.symbol && r.action === row.action && now - new Date(r.at).getTime() < SAME_SETUP_MIN * 60000));
  if (dup) return null;
  const saved = { at: new Date(now).toISOString(), ...row };
  rows.push(saved);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
  } catch { return null; }
  return saved;
}

export const listShadow = () => readAll();
