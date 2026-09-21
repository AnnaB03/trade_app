/* ---------- Phase 3: order math + safety gates ----------
   Pure functions shared by the server routes (authoritative) and the UI (display).
   Gates per build brief — A: naked short call hard block; B: short-put ack;
   C: max-loss cap; D: journal gate. Limit orders only. */
import { analyze } from "./metrics";

const usd = (v) => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);

export function validateLegs(legs) {
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 4) return "1–4 legs required";
  for (const l of legs) {
    if (!l || (l.action !== "buy" && l.action !== "sell")) return "each leg needs action buy|sell";
    if (l.type !== "call" && l.type !== "put") return "each leg needs type call|put";
    if (!(Number(l.strike) > 0)) return "each leg needs a positive strike";
    if (!(Number(l.premium) >= 0)) return "each leg needs a premium";
    if (!(Number.isInteger(Number(l.qty)) && Number(l.qty) > 0)) return "each leg needs an integer qty ≥ 1";
    if (typeof l.occ !== "string" || !parseOcc(l.occ)) return "each leg needs an OCC symbol — pick legs from a live chain";
  }
  const unders = new Set(legs.map((l) => parseOcc(l.occ).underlying));
  if (unders.size > 1) return "all legs must share one underlying";
  return null;
}

// OCC: ROOT + YYMMDD + C|P + strike*1000 padded to 8
export function parseOcc(occ) {
  const m = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ || "");
  if (!m) return null;
  return {
    underlying: m[1],
    expiration: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === "C" ? "call" : "put",
    strike: Number(m[6]) / 1000,
  };
}

// net premium per share: Σ(buy mids) − Σ(sell mids), qty-weighted. >0 debit, <0 credit
export const netPremium = (legs) =>
  legs.reduce((s, l) => s + (l.action === "buy" ? 1 : -1) * Number(l.premium) * Number(l.qty), 0);

/* Gate A — HARD BLOCK: net call exposure = Σ(long call qty) − Σ(short call qty) */
export function gateA(legs) {
  const netCalls = legs.reduce((s, l) => l.type === "call" ? s + (l.action === "buy" ? 1 : -1) * Number(l.qty) : s, 0);
  return netCalls < 0
    ? { ok: false, msg: "Blocked: naked short call — unlimited loss. Add a long call above the short strike." }
    : { ok: true, msg: "No uncapped call risk" };
}

/* Gate B — net short puts require explicit ack of the defined-but-large figure:
   Σ(short-put strikes × 100 × qty) − net credit */
export function gateB(legs, ack) {
  const netPuts = legs.reduce((s, l) => l.type === "put" ? s + (l.action === "buy" ? 1 : -1) * Number(l.qty) : s, 0);
  if (netPuts >= 0) return { ok: true, required: false, figure: null, msg: "No net short puts" };
  const credit = Math.max(0, -netPremium(legs)) * 100;
  const figure = legs
    .filter((l) => l.type === "put" && l.action === "sell")
    .reduce((s, l) => s + Number(l.strike) * 100 * Number(l.qty), 0) - credit;
  return ack === true
    ? { ok: true, required: true, figure, msg: `Acknowledged: defined-but-large risk of ${usd(figure)} if assigned at zero` }
    : { ok: false, required: true, figure, msg: `Short puts: max loss ${usd(figure)}. Tick the acknowledgement to proceed.` };
}

/* Gate C — max loss (same math as the Risk panel) vs MAX_LOSS_PER_TRADE cap.
   cap === Infinity means no cap is configured (the default while this build
   is paper-only) — always passes, with a message that says so rather than
   the nonsensical "within the $Infinity cap". */
export function gateC(legs, cap, gateBRes) {
  const a = analyze(legs);
  if (!a) return { ok: false, cap, maxLoss: null, msg: "could not compute risk" };
  const riskFigure = gateBRes?.required ? gateBRes.figure : Math.abs(a.maxL);
  if (!Number.isFinite(cap)) {
    return { ok: true, cap, maxLoss: riskFigure, msg: `Max loss ${usd(riskFigure)} — no per-trade cap set (paper trading)` };
  }
  return riskFigure > cap
    ? { ok: false, cap, maxLoss: riskFigure, msg: `Blocked: max loss ${usd(riskFigure)} exceeds the ${usd(cap)} per-trade cap (MAX_LOSS_PER_TRADE).` }
    : { ok: true, cap, maxLoss: riskFigure, msg: `Max loss ${usd(riskFigure)} within the ${usd(cap)} cap` };
}

/* Gate D — journal gate: opening needs thesis (≥20) + exit plan (≥10); closing needs outcome note */
export function gateD({ closing, thesis, exit_plan, outcome_note }) {
  if (closing) {
    return outcome_note?.trim()
      ? { ok: true, msg: "Outcome note present" }
      : { ok: false, msg: "Closing requires a non-empty outcome_note — what happened vs. your plan?" };
  }
  const missing = [];
  if (!(thesis?.trim().length >= 20)) missing.push("thesis (≥ 20 chars)");
  if (!(exit_plan?.trim().length >= 10)) missing.push("exit_plan (≥ 10 chars)");
  return missing.length
    ? { ok: false, msg: `Opening requires ${missing.join(" and ")}.` }
    : { ok: true, msg: "Thesis and exit plan present" };
}

/* Gate E — liquidity: bid–ask spread vs mid, from LIVE quotes fetched server-side
   at vet time (never trusted from the client). Spread >8% of mid (or an unquotable
   market) requires explicit ack — slippage on entry+exit is a real cost, not noise.
   legQuotes: [{ occ, bid, ask }] */
export function gateE(legQuotes, ack) {
  if (!Array.isArray(legQuotes) || !legQuotes.length) {
    return { ok: true, required: false, unavailable: true, msg: "Liquidity check unavailable — could not fetch live option quotes" };
  }
  const worst = legQuotes.reduce((w, q) => {
    const b = Number(q.bid), a = Number(q.ask);
    const mid = (a + b) / 2;
    const p = a > 0 && b >= 0 && a >= b && mid > 0 ? (a - b) / mid : null; // null = no real market
    return w === undefined || p === null || (w !== null && p > w) ? p : w;
  }, undefined);
  const pctTxt = worst == null ? "no bid (unquotable)" : `${(worst * 100).toFixed(1)}% of mid`;
  if (worst != null && worst <= 0.08) {
    return { ok: true, required: false, worst, msg: `Spreads acceptable (worst ${pctTxt})` };
  }
  return ack === true
    ? { ok: true, required: true, worst, msg: `Acknowledged: wide market (worst spread ${pctTxt}) — expect slippage both ways` }
    : { ok: false, required: true, worst, msg: `Wide market: worst leg spread is ${pctTxt}. Slippage will cost you on entry AND exit. Tick the acknowledgement to proceed.` };
}

/* Tradier order form — exact shapes from the brief. Limit orders only. */
export function buildOrderForm(legs, { closing = false, limitPrice = null, preview = false } = {}) {
  const underlying = parseOcc(legs[0].occ).underlying;
  const sideOf = (l) => closing
    ? (l.action === "buy" ? "buy_to_close" : "sell_to_close")
    : (l.action === "buy" ? "buy_to_open" : "sell_to_open");
  const net = netPremium(legs);
  const px = limitPrice != null && limitPrice !== "" ? Math.abs(Number(limitPrice)) : Math.abs(net);
  let form;
  if (legs.length === 1) {
    const l = legs[0];
    form = {
      class: "option", symbol: underlying, option_symbol: l.occ, side: sideOf(l),
      quantity: String(l.qty), type: "limit", price: px.toFixed(2), duration: "day",
    };
  } else {
    const type = net > 0 ? "debit" : net < 0 ? "credit" : "even";
    form = { class: "multileg", symbol: underlying, duration: "day", type };
    if (type !== "even") form.price = px.toFixed(2);
    legs.forEach((l, i) => {
      form[`option_symbol[${i}]`] = l.occ;
      form[`side[${i}]`] = sideOf(l);
      form[`quantity[${i}]`] = String(l.qty);
    });
  }
  if (preview) form.preview = "true";
  const side_map = Object.fromEntries(legs.map((l) => [l.occ, sideOf(l)]));
  return { form, underlying, net, side_map };
}

// P&L of a round trip in dollars: cash in/out is −net×100 at each end
export const roundTripPnl = (entryNet, exitNet) => -(Number(entryNet) + Number(exitNet)) * 100;

/* Bracket (OTO — one-triggers-other) order: the entry, plus a protective
   stop that Tradier holds GTC and only submits once the entry actually
   fills. Single long leg only, matching this app's whole design (a plan to
   buy one call/put or one equity position, never a spread). Stop-MARKET,
   not stop-limit — once a protective stop is meant to trigger, getting OUT
   is the point; a stop-limit can fail to fill entirely if price gaps past
   the limit, which is exactly when protection matters most.

   Options: stopPrice here is a PREMIUM level (the option's own price), not
   the underlying's — see buildOptionStopEstimate below for how that gets
   estimated from an underlying invalidation level. That estimate, not
   Tradier, is the part that can be wrong. */
export function buildBracketOptionForm(legs, { stopPrice, limitPrice = null, preview = false } = {}) {
  if (legs.length !== 1) throw new Error("Bracket orders support a single leg only.");
  const l = legs[0];
  const underlying = parseOcc(l.occ).underlying;
  const net = netPremium(legs);
  const entryPx = limitPrice != null && limitPrice !== "" ? Math.abs(Number(limitPrice)) : Math.abs(net);
  const form = {
    class: "oto", symbol: underlying,
    "option_symbol[0]": l.occ, "side[0]": "buy_to_open", "quantity[0]": String(l.qty), "type[0]": "limit", "price[0]": entryPx.toFixed(2), "duration[0]": "day",
    "option_symbol[1]": l.occ, "side[1]": "sell_to_close", "quantity[1]": String(l.qty), "type[1]": "stop", "stop[1]": Number(stopPrice).toFixed(2), "duration[1]": "gtc",
  };
  if (preview) form.preview = "true";
  return { form, underlying, net, side_map: { [l.occ]: "buy_to_open" } };
}

// Equity version — stopPrice is the stock's own price, an EXACT match to an
// idea's invalidation level (no delta-estimation step needed, unlike options).
export function buildBracketEquityForm({ symbol, side, quantity, price, stopPrice, preview = false }) {
  const exitSide = side === "buy" ? "sell" : "buy_to_cover";
  const form = {
    class: "oto",
    "symbol[0]": symbol, "side[0]": side, "quantity[0]": String(quantity), "type[0]": "limit", "price[0]": Number(price).toFixed(2), "duration[0]": "day",
    "symbol[1]": symbol, "side[1]": exitSide, "quantity[1]": String(quantity), "type[1]": "stop", "stop[1]": Number(stopPrice).toFixed(2), "duration[1]": "gtc",
  };
  if (preview) form.preview = "true";
  return { form };
}

// Estimate the option PREMIUM a stop needs, from an underlying invalidation
// level — first-order (delta-only), so it drifts as delta itself moves and
// ignores gamma/theta/vol changes between now and whenever it might trigger.
// Never a guarantee; shown to the trader as an editable starting point, not
// submitted silently.
export function buildOptionStopEstimate({ entryPremium, entryUnderlying, invalidation, delta }) {
  if (!(entryPremium > 0) || entryUnderlying == null || invalidation == null || delta == null) return null;
  const moveInUnderlying = invalidation - entryUnderlying; // signed
  const est = entryPremium + Number(delta) * moveInUnderlying;
  return Math.max(0.01, est);
}
