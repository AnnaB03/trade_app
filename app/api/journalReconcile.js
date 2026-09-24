/* ---------- Journal reconciliation against the Tradier sandbox ----------
   The journal used to learn an outcome only when a position was closed BY
   HAND through this app. Autopilot trades don't close by hand: a resting
   limit may never fill, and a bracket stop can fill hours later with nobody
   watching. Without this, those trades sat "open" forever and never showed
   up in any comparison. For each open journal entry with an order id, this
   reads that order back from Tradier and records what actually happened:
   - entry leg expired/canceled/rejected with nothing filled -> status "unfilled"
   - entry leg filled -> entryFillPrice (real fill, used for P&L)
   - bracket stop leg filled -> closed via journalClose at the stop's fill
   Throttled; never throws. */
import { tradeFetch, accountId, asArray } from "./tradeClient";
import { tradier, asArray as asArr } from "./tradier";
import { listJournal, updateJournalEntry } from "./store";
import { journalClose } from "./journalLib";

const MIN_INTERVAL_MS = 60 * 1000;
let lastRun = 0;
const DEAD = ["expired", "canceled", "rejected", "error"];

async function underlyingLast(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArr(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

export async function reconcileJournal({ force = false } = {}) {
  if (!force && Date.now() - lastRun < MIN_INTERVAL_MS) return { skipped: true };
  lastRun = Date.now();
  const open = listJournal().filter((j) => j.status === "open" && j.entryOrderId);
  if (!open.length) return { checked: 0, updated: 0 };
  try {
    const acct = await accountId();
    const orders = asArray((await tradeFetch(`/accounts/${acct}/orders`))?.orders?.order);
    const byId = new Map(orders.map((o) => [String(o.id), o]));
    let updated = 0;
    for (const j of open) {
      const o = byId.get(String(j.entryOrderId));
      if (!o) continue;
      const legs = asArray(o.leg);
      const entryLeg = legs[0] || o;
      const stopLeg = legs.length > 1 ? legs[1] : null;
      const filledQty = Number(entryLeg.exec_quantity) || 0;

      if (DEAD.includes(entryLeg.status) && filledQty === 0) {
        updateJournalEntry(j.id, {
          status: "unfilled", entryOrderStatus: entryLeg.status,
          exitAt: new Date().toISOString(), exitReason: `Entry limit never filled (order ${entryLeg.status})`, exitReasonTag: "unfilled",
          pnl: 0, pnlPct: 0,
        });
        updated++;
        continue;
      }

      let row = j;
      const fillPx = Number(entryLeg.avg_fill_price);
      if (filledQty > 0 && fillPx > 0 && j.entryFillPrice == null) {
        row = updateJournalEntry(j.id, {
          entryFillPrice: fillPx, entryFilledQuantity: filledQty, entryOrderStatus: entryLeg.status,
          entryFilledAt: entryLeg.transaction_date || new Date().toISOString(),
        }) || j;
        updated++;
      }

      if (stopLeg?.status === "filled" && Number(stopLeg.avg_fill_price) > 0) {
        const exitPx = Number(stopLeg.avg_fill_price);
        journalClose({ ...row, entryQuantity: row.entryFilledQuantity || row.entryQuantity }, {
          exitOrderId: stopLeg.id ?? null, exitOrderStatus: "filled",
          exitQuantity: Number(stopLeg.exec_quantity) || row.entryQuantity, exitFillPrice: exitPx,
          exitReason: "Stop hit — bracket stop filled", exitReasonTag: "stop",
          underlyingPriceAtClose: row.vehicle === "SHARES" ? exitPx : await underlyingLast(row.symbol),
        });
        updated++;
      }
    }
    return { checked: open.length, updated };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
