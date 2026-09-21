import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";
import { tradier, asArray } from "../../tradier";
import { parseOcc } from "../../../lib/orders";
import { journalOpen, journalClose } from "../../journalLib";
import { findOpenJournalEntry } from "../../store";

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

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  try {
    const isEquity = Boolean(body?.equity);
    const closing = body?.closing === true;
    const vet = isEquity ? await vetEquityOrder(body, { preview: false }) : await vetOrder(body, { preview: false });
    if (vet.error) {
      return NextResponse.json(
        { error: vet.error, gates: vet.gates ?? null, needs_ack: vet.needs_ack ?? false, figure: vet.figure ?? null, needs_spread_ack: vet.needs_spread_ack ?? false, worst_spread: vet.worst_spread ?? null },
        { status: vet.status }
      );
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
          if (entry) {
            journalClose(entry, {
              exitOrderId: orderResult?.id ?? null, exitOrderStatus: orderResult?.status ?? null,
              exitQuantity: vet.computed.quantity, exitFillPrice: vet.computed.price,
              exitReason: body.outcome_note, exitReasonTag: body.outcome_tag ?? null,
              underlyingPriceAtClose: vet.computed.price, // the equity IS the underlying
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
          if (entry) {
            const underlyingPrice = await underlyingQuote(underlying);
            journalClose(entry, {
              exitOrderId: orderResult?.id ?? null, exitOrderStatus: orderResult?.status ?? null,
              exitQuantity: Number(leg.qty) || entry.entryQuantity, exitFillPrice: Number(vet.computed.price),
              exitReason: body.outcome_note, exitReasonTag: body.outcome_tag ?? null,
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
