import { sandboxLockError, tradeFetch, accountId, asArray } from "../tradeClient";
import { validateLegs, gateA, gateB, gateC, gateE, buildOrderForm, buildBracketOptionForm, buildBracketEquityForm, netPremium } from "../../lib/orders";
import { analyze } from "../../lib/metrics";
import { tradier, asArray as asArr } from "../tradier";

// Live NBBO for each leg's OCC symbol, for the liquidity gate. [] on failure —
// gateE then reports itself unavailable instead of blocking the order.
async function fetchLegQuotes(legs) {
  try {
    const occs = legs.map((l) => l.occ).join(",");
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(occs)}`);
    const qs = asArr(d?.quotes?.quote);
    return legs
      .map((l) => {
        const q = qs.find((x) => x.symbol === l.occ);
        return q ? { occ: l.occ, bid: q.bid, ask: q.ask } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A trade this app places should always leave something for the journal to
// learn from later: an opening order needs either a linked idea (which
// already carries a thesis and a plan) or a short thesis typed by hand; a
// closing order always needs a reason, since "why did you sell" is the
// whole point of a journal. See journalLib.js for what happens with these.
function journalGateCheck(body, closing) {
  if (closing) {
    const note = (body?.outcome_note || "").trim();
    return note.length >= 5 ? null : "Closing needs a short reason (why are you closing this?) — that's what the journal is for.";
  }
  if (body?.ideaId) return null;
  const thesis = (body?.thesis || "").trim();
  return thesis.length >= 10 ? null : "Opening a manual (non-idea) trade needs a short thesis (10+ characters) so the journal has something to learn from.";
}

// No default cap while this build is hard-locked to paper trading (see
// sandboxLockError above) — real money is never at risk here, so there's
// nothing for a max-loss gate to protect by default. Set MAX_LOSS_PER_TRADE
// in .env.local if you want the gate active anyway (e.g. rehearsing size
// discipline before it matters, or ahead of ever pointing this at real money).
export const MAX_LOSS_CAP = () => {
  const n = Number(process.env.MAX_LOSS_PER_TRADE);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

/* Runs every server-side check shared by stage and place.
   Returns { error, status } on rejection, else { gates, computed, form, underlying }. */
export async function vetOrder(body, { preview }) {
  const lock = sandboxLockError();
  if (lock) return { error: lock, status: 403 };

  if (body?.type === "market" || body?.order_type === "market") {
    return { error: "Market orders are rejected for options — limit orders only.", status: 422 };
  }
  const legs = body?.legs;
  const legErr = validateLegs(legs);
  if (legErr) return { error: legErr, status: 422 };

  const closing = body?.closing === true;
  const journalErr = journalGateCheck(body, closing);
  if (journalErr) return { error: journalErr, status: 422 };

  let gates;
  if (closing) {
    // A closing order unwinds an existing position — verify each leg against live
    // positions so a mislabeled "closing" order can't open naked risk.
    const acct = await accountId();
    const pos = asArray((await tradeFetch(`/accounts/${acct}/positions`))?.positions?.position);
    for (const l of legs) {
      const p = pos.find((x) => x.symbol === l.occ);
      const q = Number(p?.quantity) || 0;
      const okDir = l.action === "sell" ? q >= Number(l.qty) : q <= -Number(l.qty);
      if (!p || !okDir) {
        return { error: `Closing order does not match an open position for ${l.occ} (have ${q}, closing ${l.action} ${l.qty}).`, status: 422 };
      }
    }
    gates = { closing_verified: { ok: true, msg: "Legs verified against open positions" } };
  } else {
    const a = gateA(legs);
    if (!a.ok) return { error: a.msg, status: 422, gates: { a } };
    const b = gateB(legs, body?.ack_defined_large_risk);
    const c = gateC(legs, MAX_LOSS_CAP(), b);
    if (!c.ok) return { error: c.msg, status: 422, gates: { a, b, c } };
    if (!b.ok) return { error: b.msg, status: 422, gates: { a, b, c }, needs_ack: true, figure: b.figure };
    const e = gateE(await fetchLegQuotes(legs), body?.ack_wide_spread);
    if (!e.ok) return { error: e.msg, status: 422, gates: { a, b, c, e }, needs_spread_ack: true, worst_spread: e.worst };
    gates = { a, b, c, e };
  }

  const risk = analyze(legs);
  // A stop only makes sense on an OPENING order — a closing order already
  // IS the exit. stopPrice here is an option PREMIUM level (see
  // buildOptionStopEstimate in lib/orders.js for how the client derives one
  // from an underlying invalidation) — Tradier has no way to trigger a stop
  // off the underlying for an option order.
  const stopPrice = !closing && legs.length === 1 ? Number(body?.stop?.price) : null;
  const attachStop = stopPrice > 0;
  const { form, underlying, net, side_map } = attachStop
    ? buildBracketOptionForm(legs, { stopPrice, limitPrice: body?.limit_price, preview })
    : buildOrderForm(legs, { closing, limitPrice: body?.limit_price, preview });
  return {
    gates, form, underlying,
    computed: {
      net, suggested_limit: Math.abs(netPremium(legs)),
      // max_loss/max_profit are finite dollar figures OR null when genuinely
      // uncapped (analyze() uses Infinity/-Infinity internally, but JSON has
      // no way to represent that — JSON.stringify(Infinity) silently becomes
      // null over the wire). unlimited_profit/unlimited_loss carry that fact
      // explicitly so a null here is never mistaken for "$0".
      max_loss: risk && Number.isFinite(risk.maxL) ? risk.maxL : null,
      max_profit: risk && Number.isFinite(risk.maxP) ? risk.maxP : null,
      unlimited_loss: risk?.unlimitedLoss ?? false,
      unlimited_profit: risk?.unlimitedProfit ?? false,
      breakevens: risk ? risk.bes : [],
      side_map,
      order_class: form.class, order_type: form.type, price: form.price ?? form["price[0]"] ?? null,
      stop_attached: attachStop, stop_price: attachStop ? stopPrice : null,
    },
  };
}

export async function submitOrder(form) {
  const acct = await accountId();
  return tradeFetch(`/accounts/${acct}/orders`, { method: "POST", form });
}

/* Equity (plain shares) version of vetOrder, for the SHARES ideas the Ideas
   tab can propose and for closing them back out. Simpler than the options
   path: no multi-leg payoff math, no naked-call/short-put gates (a short
   equity position is a normal, well-understood order type, not the same
   footgun as an undefined-risk option structure) — just a valid limit
   order, still paper-only via the same sandbox lock. body.equity for an
   OPEN: { symbol, side: "buy"|"sell", quantity, price, stop? } — stop is
   optional and only used to show an estimated risk figure, not to gate
   anything. For a CLOSE (body.closing === true): { symbol, quantity, price }
   — side is derived from the live position (sell for a long, buy_to_cover
   for a short), verified against Tradier so a mislabeled close can't
   accidentally open the opposite exposure. */
export async function vetEquityOrder(body, { preview }) {
  const lock = sandboxLockError();
  if (lock) return { error: lock, status: 403 };
  if (body?.type === "market" || body?.order_type === "market") {
    return { error: "Market orders are rejected — limit orders only.", status: 422 };
  }
  const eq = body?.equity;
  if (!eq || typeof eq.symbol !== "string" || !eq.symbol.trim()) {
    return { error: "equity.symbol required", status: 422 };
  }
  const qty = Number(eq.quantity);
  if (!(Number.isInteger(qty) && qty > 0)) return { error: "equity.quantity must be a positive whole number of shares", status: 422 };
  const price = Number(eq.price);
  if (!(price > 0)) return { error: "equity.price (limit price) must be a positive number", status: 422 };
  const symbol = eq.symbol.trim().toUpperCase();
  const closing = body?.closing === true;

  const journalErr = journalGateCheck(body, closing);
  if (journalErr) return { error: journalErr, status: 422 };

  let side, gates;
  if (closing) {
    const acct = await accountId();
    const pos = asArray((await tradeFetch(`/accounts/${acct}/positions`))?.positions?.position);
    const p = pos.find((x) => x.symbol === symbol);
    const heldQty = Number(p?.quantity) || 0; // positive = long, negative = short
    if (!p || heldQty === 0) return { error: `No open equity position found for ${symbol}.`, status: 422 };
    if (heldQty > 0) {
      if (qty > heldQty) return { error: `Closing quantity ${qty} exceeds the open long position (${heldQty} sh) for ${symbol}.`, status: 422 };
      side = "sell";
    } else {
      if (qty > Math.abs(heldQty)) return { error: `Closing quantity ${qty} exceeds the open short position (${Math.abs(heldQty)} sh) for ${symbol}.`, status: 422 };
      side = "buy_to_cover";
    }
    gates = { closing_verified: { ok: true, msg: `Verified against the open ${heldQty > 0 ? "long" : "short"} position (${Math.abs(heldQty)} sh)` } };
  } else {
    side = eq.side === "buy" ? "buy" : eq.side === "sell" ? "sell_short" : null;
    if (!side) return { error: "equity.side must be 'buy' or 'sell'", status: 422 };
    gates = {
      equity: side === "sell_short"
        ? { ok: true, msg: "Short equity opened — loss is theoretically unlimited above the entry price. Paper money only in this build." }
        : { ok: true, msg: "Long equity — loss is bounded, at worst, to the position's value." },
    };
  }

  const stop = Number(eq.stop);
  const estRisk = stop > 0 ? Math.abs(price - stop) * qty : null;
  // Equity stops are exact — no delta-estimation step like options need,
  // since the invalidation level and the stop trigger are the same units
  // (the stock's own price). Opt-in via eq.attachStop; never on a closing
  // order, which already IS the exit.
  const attachStop = !closing && eq.attachStop === true && stop > 0;
  const { form } = attachStop
    ? buildBracketEquityForm({ symbol, side, quantity: qty, price, stopPrice: stop, preview })
    : { form: { class: "equity", symbol, side, quantity: String(qty), type: "limit", price: price.toFixed(2), duration: "day", ...(preview ? { preview: "true" } : {}) } };

  return {
    gates, form, underlying: symbol,
    computed: {
      side, quantity: qty, price, est_risk_at_stop: estRisk,
      order_class: "equity", order_type: "limit",
      stop_attached: attachStop, stop_price: attachStop ? stop : null,
    },
  };
}
