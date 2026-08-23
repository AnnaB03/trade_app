/* ---------- Phase 2 analytics — pure functions, formulas per build brief ---------- */

/* ---------- risk math (defined-risk + uncapped-risk detection) ----------
   Shared by the Risk panel (client) and the Phase 3 order gates (server). */
export const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const intrinsic = (t, K, S) => (t === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0));

export function analyze(legs) {
  const v = legs.filter((l) => l.strike !== "" && l.premium !== "");
  if (!v.length) return null;
  const pnl = (S) => v.reduce((s, l) => {
    const intr = intrinsic(l.type, num(l.strike), S);
    const per = l.action === "buy" ? intr - num(l.premium) : num(l.premium) - intr;
    return s + per * (num(l.qty) || 1) * 100;
  }, 0);
  const net = v.reduce((s, l) => s + (l.action === "buy" ? 1 : -1) * num(l.premium) * (num(l.qty) || 1) * 100, 0);
  const callSlope = v.reduce((s, l) => l.type === "call" ? s + (l.action === "buy" ? 1 : -1) * (num(l.qty) || 1) : s, 0);
  const unlimitedLoss = callSlope < 0, unlimitedProfit = callSlope > 0;
  const strikes = v.map((l) => num(l.strike));
  const pts = Array.from(new Set([0, ...strikes, Math.max(...strikes) * 3 + 50])).sort((a, b) => a - b);
  const samp = pts.map((S) => ({ S, p: pnl(S) }));
  let maxP = Math.max(...samp.map((d) => d.p)), maxL = Math.min(...samp.map((d) => d.p));
  if (unlimitedProfit) maxP = Infinity; if (unlimitedLoss) maxL = -Infinity;
  const bes = [];
  for (let i = 1; i < samp.length; i++) {
    const a = samp[i - 1], b = samp[i];
    if (((a.p <= 0 && b.p >= 0) || (a.p >= 0 && b.p <= 0)) && a.p !== b.p) {
      const S = a.S + (b.S - a.S) * (0 - a.p) / (b.p - a.p);
      if (S >= 0) bes.push(S);
    }
  }
  const rr = isFinite(maxP) && isFinite(maxL) && maxL !== 0 ? Math.abs(maxP / maxL) : null;
  return { net, maxP, maxL, bes, unlimitedLoss, unlimitedProfit, rr };
}

// mid = (bid+ask)/2; fall back to last when bid/ask missing or empty
export const optMid = (o) => {
  if (!o) return null;
  const b = Number(o.bid), a = Number(o.ask);
  if (o.bid != null && o.ask != null && b + a > 0) return (b + a) / 2;
  return o.last != null ? Number(o.last) : null;
};

// rows: [{strike, call, put}] — group a flat chain by strike
export const toRows = (options) => {
  const m = {};
  (options || []).forEach((o) => { (m[o.strike] = m[o.strike] || {})[o.type] = o; });
  return Object.keys(m).map(Number).sort((x, y) => x - y).map((k) => ({ strike: k, ...m[k] }));
};

/* Feature 1 — Expected Move (straddle method):
   ATM strike = closest to spot; EM$ = ATM call mid + ATM put mid; EM% = EM$/spot */
export function expectedMove(rows, spot) {
  if (spot == null || !rows?.length) return null;
  const candidates = rows.filter((r) => r.call && r.put);
  if (!candidates.length) return null;
  const atm = candidates.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b);
  const cm = optMid(atm.call), pm = optMid(atm.put);
  if (cm == null || pm == null || cm + pm <= 0) return null;
  const em = cm + pm;
  return { atmStrike: atm.strike, em, emPct: em / spot, low: spot - em, high: spot + em };
}

export function moveVerdict(userPct, impliedPct) {
  if (userPct == null || impliedPct == null || !(impliedPct > 0)) return null;
  if (userPct > impliedPct * 1.25) return { tone: "bull", text: "You expect MORE movement than priced → long premium / debit spreads favored" };
  if (userPct < impliedPct * 0.75) return { tone: "bear", text: "You expect LESS movement than priced → short premium / credit spreads favored" };
  return { tone: "flat", text: "Your view ≈ market's — no vol edge; direction is the only edge here" };
}

/* Feature 2 — IV snapshot: average mid_iv across the 6 strikes nearest ATM (3 calls + 3 puts) */
export function ivSnapshot(rows, spot) {
  if (spot == null || !rows?.length) return null;
  const near = rows
    .filter((r) => r.call?.iv != null || r.put?.iv != null)
    .sort((x, y) => Math.abs(x.strike - spot) - Math.abs(y.strike - spot))
    .slice(0, 3);
  const ivs = near.flatMap((r) => [r.call?.iv, r.put?.iv]).filter((v) => v != null && Number(v) > 0).map(Number);
  if (ivs.length < 2) return null;
  return ivs.reduce((s, v) => s + v, 0) / ivs.length;
}

// IV Rank = (current − min) / (max − min) × 100 over stored history
export function ivRank(history, current) {
  const vals = (history || []).map((h) => h.iv).filter((v) => v != null);
  if (current != null) vals.push(current);
  if (vals.length < 10) return { rank: null, n: vals.length };
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return { rank: 50, n: vals.length };
  return { rank: ((current - min) / (max - min)) * 100, n: vals.length };
}

export const ivRankRead = (rank) =>
  rank == null ? null : rank >= 60 ? "high — favor selling premium" : rank <= 30 ? "low — favor buying premium" : "middling";

// Nearest monthly expiration = first date in the list that is a third Friday
export function nearestMonthly(exps) {
  for (const d of exps || []) {
    const [y, m, day] = d.split("-").map(Number);
    const dt = new Date(y, m - 1, day);
    if (dt.getDay() === 5 && day >= 15 && day <= 21) return d;
  }
  return exps?.[0] ?? null;
}

/* Feature 4 — OI walls & put/call skew */
export function oiWalls(rows) {
  let callWall = null, putWall = null, totCall = 0, totPut = 0;
  for (const r of rows || []) {
    const co = Number(r.call?.oi) || 0, po = Number(r.put?.oi) || 0;
    totCall += co; totPut += po;
    if (co > 0 && (!callWall || co > callWall.oi)) callWall = { strike: r.strike, oi: co };
    if (po > 0 && (!putWall || po > putWall.oi)) putWall = { strike: r.strike, oi: po };
  }
  if (!callWall && !putWall) return null;
  const pc = totCall > 0 ? totPut / totCall : null;
  const note = pc == null ? "" : pc < 0.7 ? "call-heavy (crowd leaning bullish)" : pc > 1.3 ? "put-heavy (crowd leaning bearish / hedged)" : "balanced";
  return { callWall, putWall, pc, note };
}

/* Feature 5 — Event risk */
export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const daysUntil = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 86400000);
};
// events you'd hold through: today ≤ event date ≤ position expiration
export const eventsHeldThrough = (events, exp) =>
  (events || []).filter((ev) => ev.date && exp && ev.date <= exp && daysUntil(ev.date) >= 0);

/* Feature 3 — Divergence: normalize both to −1…+1, divergence = price_norm − sent_norm */
export function divergence(price30Pct, sentiment) {
  if (price30Pct == null || sentiment == null) return null;
  const priceNorm = Math.max(-15, Math.min(15, Number(price30Pct))) / 15;
  const sentNorm = (Number(sentiment) - 50) / 50;
  const score = priceNorm - sentNorm;
  const label = score <= -0.6 ? "CROWD HOT / TAPE WEAK — euphoria unconfirmed (caution / fade-watch)"
    : score >= 0.6 ? "TAPE STRONG / CROWD COLD — wall of worry (continuation-watch)"
    : "aligned";
  return { score, label, priceNorm, sentNorm };
}

/* Feature 7 — Option liquidity: bid–ask spread as a fraction of mid.
   The spread is what you pay the market maker to get in AND out; wide spreads
   quietly eat more than most losing theses. null when unquotable (no bid). */
export function spreadPct(o) {
  if (!o) return null;
  const b = Number(o.bid), a = Number(o.ask);
  if (!(a > 0) || !(b >= 0) || a < b) return null;
  const mid = (a + b) / 2;
  if (!(mid > 0)) return null;
  return (a - b) / mid;
}
// tiers: ok ≤4% · wide ≤8% · bad >8% (or no bid at all)
export const spreadFlag = (p) => p == null ? "bad" : p > 0.08 ? "bad" : p > 0.04 ? "wide" : "ok";
export const spreadRead = (flag) =>
  flag === "bad" ? "very wide/no market — entry+exit slippage will be severe"
  : flag === "wide" ? "wide market — use limit orders at mid, expect to give some up"
  : "tight market";

/* Feature 8 — Realized (historical) volatility: annualized stdev of daily log
   returns over the last n closes, ×√252. Compare with implied: IV >> HV means
   options are pricing more movement than the stock has delivered (rich);
   IV << HV means cheaper than delivered movement. */
export function realizedVol(closes, n) {
  const c = (closes || []).map(Number).filter((v) => v > 0);
  if (c.length < n + 1) return null;
  const w = c.slice(-(n + 1));
  const rets = [];
  for (let i = 1; i < w.length; i++) rets.push(Math.log(w[i] / w[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varc = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}

export function ivHvRead(iv, hv) {
  if (!(iv > 0) || !(hv > 0)) return null;
  const ratio = iv / hv;
  if (ratio >= 1.25) return { ratio, tone: "sell", text: "options EXPENSIVE vs realized — edge favors selling premium / credit spreads" };
  if (ratio <= 0.8) return { ratio, tone: "buy", text: "options CHEAP vs realized — edge favors buying premium / debit spreads" };
  return { ratio, tone: "fair", text: "options fairly priced vs realized movement — no vol edge either way" };
}

/* Feature 6 — Journal stats (closed = status other than open; win = status "won") */
export function journalStats(entries) {
  const closed = (entries || []).filter((e) => e.status && e.status !== "open");
  const n = closed.length;
  const rate = (list) => {
    const c = list.length;
    if (!c) return null;
    return list.filter((e) => e.status === "won").length / c;
  };
  const wins = closed.filter((e) => e.status === "won");
  const losses = closed.filter((e) => e.status === "lost");
  const avg = (list) => list.length ? list.reduce((s, e) => s + (Number(e.pnl) || 0), 0) / list.length : null;
  const avgWin = avg(wins), avgLossRaw = avg(losses);
  const avgLoss = avgLossRaw == null ? null : Math.abs(avgLossRaw);
  const winRate = rate(closed), lossRate = n ? losses.length / n : null;
  const expectancy = winRate != null && avgWin != null && avgLoss != null
    ? winRate * avgWin - lossRate * avgLoss : null;
  return {
    nClosed: n,
    winRate,
    byPremium: { bought: rate(closed.filter((e) => e.premium === "bought")), sold: rate(closed.filter((e) => e.premium === "sold")) },
    byDirection: { bull: rate(closed.filter((e) => e.direction === "bull")), bear: rate(closed.filter((e) => e.direction === "bear")), neutral: rate(closed.filter((e) => e.direction === "neutral")) },
    avgWin, avgLoss, expectancy,
  };
}
