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
import { journalClose, realizedPnl } from "./journalLib";

const MIN_INTERVAL_MS = 60 * 1000;
let lastRun = 0;
const DEAD = ["expired", "canceled", "rejected", "error"];

/* Did a price actually TRADE on the fill date? This is the honest test for a
   suspicious fill, and it replaces comparing the fill to our own limit.
   The sandbox order engine prices off ~15-minute-delayed data while the app
   reads real-time quotes, so a fill landing several percent away from the
   limit is usually just those fifteen minutes of movement, not a fabricated
   price. Measured: MRVL fell $2.50 in the quarter hour before a fill, which
   entirely explains a gap I had been calling an artifact. Flagging on
   limit-divergence alone wrongly branded the TSLA (-5.9%) and INTC (-6.5%)
   fills as simulation, and both were inside their day's range. A fill OUTSIDE
   the day's high/low is different: that price never existed at any point, which
   is what DXST filling at $1.95 against a $1.9944 low actually was. */
async function tradedThatDay(symbol, isoDate) {
  try {
    const day = String(isoDate || "").slice(0, 10);
    if (!day) return null;
    const d = await tradier(`/markets/history?symbol=${encodeURIComponent(symbol)}&start=${day}&end=${day}&interval=daily`, { timeoutMs: 6000 });
    let bar = d?.history?.day;
    bar = Array.isArray(bar) ? bar[0] : bar;
    const low = Number(bar?.low), high = Number(bar?.high);
    if (!(low > 0) || !(high > 0)) return null;
    return { low, high };
  } catch {
    return null;
  }
}

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
  /* Closes that were submitted and confirmed FILLED by the broker, but whose
     post-submit confirmation lost the race and left the row with no exit price.
     The confirmed-fill guard is right to refuse booking the limit, but nothing
     ever retried, so the realised P&L was silently dropped from the week.
     Happened for real: SPCX 10/30 $162.50c, 12 contracts, broker filled $8.90
     against a $7.20 entry — $2,040 that existed at the broker and was missing
     from every total until it was repaired by hand. */
  const unbooked = listJournal().filter((j) => j.status === "closed" && j.exitOrderId && j.exitFillPrice == null);
  if (!open.length && !unbooked.length) return { checked: 0, updated: 0 };
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
        // Judged by tradedThatDay above, not by divergence from our own limit.
        const limitPx = Number(j.entryLimitPrice);
        const patch = {
          entryFillPrice: fillPx, entryFilledQuantity: filledQty, entryOrderStatus: entryLeg.status,
          entryFilledAt: entryLeg.transaction_date || new Date().toISOString(),
        };
        if (limitPx > 0) {
          const gapPct = ((fillPx - limitPx) / limitPx) * 100;
          if (Math.abs(gapPct) >= 5) {
            patch.fillGapPct = Number(gapPct.toFixed(1));
            const occOrSym = j.occ || j.symbol;
            const range = await tradedThatDay(occOrSym, patch.entryFilledAt);
            if (range && (fillPx < range.low || fillPx > range.high)) {
              patch.fillSuspect = true;
              patch.fillNote = `Filled at $${fillPx}, OUTSIDE the ${patch.entryFilledAt.slice(0, 10)} range of $${range.low}-$${range.high} — that price never traded, so any P&L on this row is simulation artifact rather than edge.`;
            } else if (range) {
              patch.fillSuspect = false;
              patch.fillNote = `Filled at $${fillPx} against a $${limitPx} limit (${gapPct.toFixed(1)}%), but inside the day's $${range.low}-$${range.high} range — the gap is the sandbox's ~15-minute data delay, not a fabricated price. Treat this P&L as real.`;
            } else {
              patch.fillNote = `Filled at $${fillPx} against a $${limitPx} limit (${gapPct.toFixed(1)}%); could not fetch that day's range to judge whether the price was real.`;
            }
          }
        }
        row = updateJournalEntry(j.id, patch) || j;
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
    // Retry the exit confirmation for any close still missing its fill price.
    for (const j of unbooked) {
      const o = byId.get(String(j.exitOrderId));
      if (!o) continue;
      const legs = asArray(o.leg);
      const leg = legs.find((l) => Number(l.exec_quantity) > 0 && Number(l.avg_fill_price) > 0) || o;
      const px = Number(leg.avg_fill_price), qty = Number(leg.exec_quantity) || Number(j.exitQuantity) || 0;
      if (!(px > 0) || !(qty > 0)) continue;
      // Same arithmetic as a normal close, fees included.
      const { pnl, pnlPct } = realizedPnl({ ...j, entryQuantity: qty }, px);
      if (pnl == null) continue;
      updateJournalEntry(j.id, {
        exitFillPrice: px, exitOrderStatus: "filled", exitQuantity: qty,
        pnl, pnlPct,
        exitReason: `${String(j.exitReason || "").split(" [submitted at")[0]} [P&L booked on a later pass from the broker's confirmed fill $${px}; the post-submit confirmation had lost the race]`,
      });
      updated++;
    }
    return { checked: open.length + unbooked.length, updated };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
