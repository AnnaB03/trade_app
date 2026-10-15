import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder, confirmOrderFill } from "../common";
import { tradier, asArray } from "../../tradier";
import { parseOcc } from "../../../lib/orders";
import { tradeFetch, accountId } from "../../tradeClient";
import { journalOpen, journalClose } from "../../journalLib";
import { findOpenJournalEntry, listJournal, updateJournalEntry } from "../../store";

/* Place = run all the same gates as Stage, then actually submit the order to
   Tradier — still the sandbox (paper money) only, per the hard lock in
   tradeClient.js, but this one creates a REAL order in that paper account,
   which is why Stage alone never showed up there. Same request shape as
   /api/order/stage, plus: `ideaId` (links an OPEN to its originating Ideas
   card so the journal inherits its plan), `thesis` (required instead, for a
   manual open with no ideaId), and `outcome_note` (required on any close —
   the reason for selling). See app/api/journalLib.js for what happens with
   these. A journal-write failure never masks a successful Tradier order. */

async function underlyingQuote(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

/* A close that was submitted, then cancelled and re-submitted, leaves the
   journal row closed and still pointing at the CANCELLED order: the second
   submit finds no open row to attach to. AVGO 10/30 $360c on 2026-10-05 — a
   resting $15.55 sell was cancelled and replaced by a $15.50 sell that filled,
   while the row kept the dead order id and never booked the +$300. The
   reconcile retry pass books a close from whatever order id the row carries,
   so re-pointing the id is enough. Returns true if a row was re-linked. */
// Cancels every working sell for one option contract (occ) or one stock (symbol).
async function cancelWorkingSells({ occ, symbol }) {
  if (!occ && !symbol) return [];
  const cancelled = [];
  try {
    const acct = await accountId();
    const d = await tradeFetch(`/accounts/${acct}/orders`);
    for (const o of asArray(d?.orders?.order)) {
      const legs = asArray(o.leg).length ? asArray(o.leg) : [o];
      const working = legs.some((l) => ["open", "pending", "partially_filled"].includes(l.status ?? o.status) && /^sell/.test(String(l.side ?? o.side))
        && (occ ? (l.option_symbol ?? o.option_symbol) === occ : !(l.option_symbol ?? o.option_symbol) && (l.symbol ?? o.symbol) === symbol));
      if (!working) continue;
      try { await tradeFetch(`/accounts/${acct}/orders/${o.id}`, { method: "DELETE" }); cancelled.push(o.id); } catch {}
    }
  } catch (e) { console.error("cancelWorkingSells failed:", e); }
  return cancelled;
}

function relinkCancelledClose(matchFn, newOrderId) {
  if (!newOrderId) return false;
  const stale = listJournal().find((r) => r.status === "closed" && r.exitOrderId && r.exitFillPrice == null && matchFn(r));
  if (!stale) return false;
  updateJournalEntry(stale.id, { exitOrderId: newOrderId, exitOrderStatus: "ok" });
  return true;
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  try {
    const isEquity = Boolean(body?.equity);
    const closing = body?.closing === true;
    /* A close REPLACES any sell already working on the same contract
       (2026-10-15). The owner sold AMZN 11/6 $250c at $13.50, above the
       $13.35 bid; it rested, and a second sell at the bid was refused ("2
       committed to other working sell orders") with no way to cancel the
       first. The journal row is re-linked to the new order below
       (relinkCancelledClose). */
    if (closing) await cancelWorkingSells(isEquity ? { symbol: String(body.symbol || "").toUpperCase() } : { occ: body.legs?.[0]?.occ });
    const vet = isEquity ? await vetEquityOrder(body, { preview: false }) : await vetOrder(body, { preview: false });
    if (vet.error) {
      return NextResponse.json(
        { error: vet.error, gates: vet.gates ?? null, needs_ack: vet.needs_ack ?? false, figure: vet.figure ?? null, needs_spread_ack: vet.needs_spread_ack ?? false, worst_spread: vet.worst_spread ?? null },
        { status: vet.status }
      );
    }

    /* A close has to release the position's own protective stop first: the stop
       is a working sell for the same quantity, and a broker will not accept two
       sells against one position. autoexit already does this; a close from the
       Journal tab did not, and was refused. */
    if (closing) {
      const occ = body.legs?.[0]?.occ;
      const row = findOpenJournalEntry((r) => (isEquity ? r.vehicle === "SHARES" && r.symbol === vet.underlying : r.occ === occ));
      if (row?.entryOrderId) {
        try { await tradeFetch(`/accounts/${await accountId()}/orders/${row.entryOrderId}`, { method: "DELETE" }); } catch {}
      }
    }

    const orderResult = (await submitOrder(vet.form))?.order ?? null;

    try {
      if (isEquity) {
        if (!closing) {
          journalOpen({
            ideaId: body.ideaId ?? null, thesis: body.thesis ?? null,
            vehicle: "SHARES", symbol: vet.underlying, side: vet.computed.side,
            quantity: vet.computed.quantity, limitPrice: vet.computed.price, order: orderResult,
          });
        } else {
          const entry = findOpenJournalEntry((r) => r.vehicle === "SHARES" && r.symbol === vet.underlying);
          if (!entry) relinkCancelledClose((r) => r.vehicle === "SHARES" && r.symbol === vet.underlying, orderResult?.id ?? null);
          if (entry) {
            // Book the broker's confirmed fill, never the limit we submitted.
            const got = await confirmOrderFill(orderResult?.id ?? null);
            const exitPx = got?.filled ? got.price : null;
            journalClose(entry, {
              exitOrderId: orderResult?.id ?? null, exitOrderStatus: got?.filled ? "filled" : (orderResult?.status ?? null),
              exitQuantity: got?.quantity || vet.computed.quantity, exitFillPrice: exitPx,
              exitReason: exitPx != null ? body.outcome_note : `${body.outcome_note} [submitted at $${vet.computed.price} but no fill confirmed yet — P&L left uncomputed rather than booked against the limit]`,
              exitReasonTag: body.outcome_tag ?? null,
              underlyingPriceAtClose: exitPx, // the equity IS the underlying
            });
          }
        }
      } else {
        const leg = body.legs?.[0];
        const parsed = leg?.occ ? parseOcc(leg.occ) : null;
        const underlying = parsed?.underlying ?? vet.underlying;
        if (!closing) {
          journalOpen({
            ideaId: body.ideaId ?? null, thesis: body.thesis ?? null,
            vehicle: "OPTION", symbol: underlying,
            occ: leg?.occ ?? null, strike: parsed?.strike ?? null, optionType: parsed?.type ?? null,
            expiration: parsed?.expiration ?? null, side: "buy",
            quantity: Number(leg?.qty) || 1, limitPrice: Number(vet.computed.price),
            order: orderResult,
          });
        } else if (leg?.occ) {
          const entry = findOpenJournalEntry((r) => r.occ === leg.occ);
          if (!entry) relinkCancelledClose((r) => r.occ === leg.occ, orderResult?.id ?? null);
          if (entry) {
            const underlyingPrice = await underlyingQuote(underlying);
            // Book the broker's confirmed fill, never the limit we submitted.
            const got = await confirmOrderFill(orderResult?.id ?? null);
            const exitPx = got?.filled ? got.price : null;
            journalClose(entry, {
              exitOrderId: orderResult?.id ?? null, exitOrderStatus: got?.filled ? "filled" : (orderResult?.status ?? null),
              exitQuantity: got?.quantity || Number(leg.qty) || entry.entryQuantity, exitFillPrice: exitPx,
              exitReason: exitPx != null ? body.outcome_note : `${body.outcome_note} [submitted at $${vet.computed.price} but no fill confirmed yet — P&L left uncomputed rather than booked against the limit]`,
              exitReasonTag: body.outcome_tag ?? null,
              underlyingPriceAtClose: underlyingPrice,
            });
          }
        }
      }
    } catch (e) {
      console.error("Journal write failed (order was still placed successfully):", e);
    }

    return NextResponse.json({ gates: vet.gates, order: orderResult, computed: vet.computed });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
