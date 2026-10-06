/* The $10K ledger boundary.

   On 2026-10-06 the working account became $10,000 and the user asked to start
   from scratch: positions already open were to be left out of the $10K
   account's accounting, not carried into it. They stay at the broker and keep
   being managed (the exits still run), but they do not count toward the
   capital ceiling, the per-symbol exposure, the daily entry cap, or the
   ledger's P&L.

   The boundary is a timestamp in data/baseline.json, so it can be reset
   without a restart and without rewriting history. A row is LEGACY if it was
   created before the baseline, or carries `legacy: true`. */
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "baseline.json");

export function readBaseline() {
  try {
    const b = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const t = new Date(b.freshStartAt).getTime();
    return { ...b, freshStartMs: t > 0 ? t : 0 };
  } catch {
    return { freshStartAt: null, freshStartMs: 0 };
  }
}

export function isLegacy(row, baseline = readBaseline()) {
  if (row?.legacy === true) return true;
  const created = new Date(row?.createdAt).getTime();
  return baseline.freshStartMs > 0 && created > 0 && created < baseline.freshStartMs;
}
