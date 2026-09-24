import { vetOrder, vetEquityOrder, submitOrder } from "./common";
import { tradier, asArray } from "../tradier";
import { journalOpen } from "../journalLib";
import { buildOptionStopEstimate } from "../../lib/orders";

/* Order placement shared by the paper autopilots — the AI-ideas one
   (order/autotrade) and the liquidity-sweep one (sweeps/autotrade) — so
   both strategies buy through the exact same gates, bracket stop, sizing
   rounding and journal write, and any difference in their results comes
   from the setups, not from how the orders were sent. */

export async function liveQuote(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

export async function placeOption(idea, { dryRun }) {
  const leg = idea.leg;
  if (!leg?.occ) return { placed: false, reason: "No resolved contract (leg.occ) for this idea." };
  const stopEst = idea.invalidation != null && leg.delta != null
    ? buildOptionStopEstimate({ entryPremium: leg.mid ?? leg.ask, entryUnderlying: idea.entryPrice, invalidation: idea.invalidation, delta: leg.delta })
    : null;
  const body = {
    legs: [{ action: "buy", type: idea.action === "CALL" ? "call" : "put", strike: String(leg.strike), premium: String(leg.mid ?? leg.ask ?? 0), qty: 1, occ: leg.occ }],
    closing: false,
    ideaId: idea.id,
    ...(stopEst > 0 ? { stop: { price: stopEst } } : {}),
  };
  if (dryRun) return { placed: false, dryRun: true, wouldPlace: body };

  const vet = await vetOrder(body, { preview: false });
  if (vet.error) return { placed: false, reason: vet.error, needsAck: Boolean(vet.needs_ack || vet.needs_spread_ack) };
  const orderResult = (await submitOrder(vet.form))?.order ?? null;
  try {
    journalOpen({
      ideaId: idea.id, thesis: null, vehicle: "OPTION", symbol: idea.symbol,
      occ: leg.occ, strike: leg.strike, optionType: idea.action === "CALL" ? "call" : "put",
      expiration: idea.expiration, side: "buy", quantity: 1, limitPrice: Number(vet.computed.price), order: orderResult,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return { placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price };
}

export async function placeShares(idea, { dryRun, allowUnaffordable }) {
  const entry = Number(idea.entryPrice);
  if (!(entry > 0)) return { placed: false, reason: "No entry price on this idea." };
  const sized = idea.sizing?.vehicle === "SHARES" ? idea.sizing.shares : null;
  // Sandbox needs whole shares — fractional sizing (fine on real Robinhood)
  // rounds up to 1 rather than being skipped, so a cheap, well-sized idea
  // still gets a real paper fill instead of silently doing nothing.
  const qty = Math.max(1, Math.round(sized > 0 ? sized : 250 / entry));
  const dollarCost = qty * entry;
  if (!allowUnaffordable && idea.sizing?.pctOfAccount != null && idea.sizing.pctOfAccount > 0.25) {
    return { placed: false, reason: `Sized position (${qty} sh ≈ $${dollarCost.toFixed(0)}) exceeds the account's 25% position cap.` };
  }
  const body = {
    equity: {
      symbol: idea.symbol, side: idea.action === "SELL" ? "sell" : "buy", quantity: qty, price: entry,
      stop: idea.invalidation ?? undefined, attachStop: idea.invalidation != null,
    },
    closing: false,
    ideaId: idea.id,
  };
  if (dryRun) return { placed: false, dryRun: true, wouldPlace: body };

  const vet = await vetEquityOrder(body, { preview: false });
  if (vet.error) return { placed: false, reason: vet.error };
  const orderResult = (await submitOrder(vet.form))?.order ?? null;
  try {
    journalOpen({
      ideaId: idea.id, thesis: null, vehicle: "SHARES", symbol: idea.symbol,
      side: vet.computed.side, quantity: vet.computed.quantity, limitPrice: vet.computed.price, order: orderResult,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return { placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price };
}
