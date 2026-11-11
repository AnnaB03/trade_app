/* The public scoreboard (owner, 2026-11-11: "lets build a live scoreboard
   with a free address"). Pure: journal rows in, the public record out. It
   carries trades and totals ONLY: no account numbers, order ids, theses,
   broker or idea fields, nothing that could identify the owner. Paper money,
   and the page says so. */
export const SCOREBOARD_START = "2026-11-04";      // the day the current rules began; the owner picks the public start
export const SCOREBOARD_START_BALANCE = 25000;

const WHY = {
  take_profit_usd: "quick profit", take_profit: "profit target", target: "target", pct50: "profit target",
  stop: "stop", stop_hit: "stop", premium_stop: "stop", max_loss: "stop", invalidation: "idea invalidated",
  eod_flat: "end of day", eod_take_profit: "end of day", market_turned: "market turned", reversed: "idea reversed",
  manual: "sold by hand",
};
const etDay = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
const r2 = (x) => Math.round(x * 100) / 100;

export function buildScoreboard(rows, { start = SCOREBOARD_START, startBalance = SCOREBOARD_START_BALANCE, now = new Date() } = {}) {
  const trades = [];
  for (const r of rows || []) {
    if (!r?.entryAt || !(Number(r.entryFillPrice) > 0) || etDay(r.entryAt) < start) continue;
    if (["unfilled", "orphaned"].includes(r.exitReasonTag)) continue;
    const opt = r.vehicle === "OPTION";
    const closed = r.exitAt && r.exitFillPrice != null && Number.isFinite(Number(r.pnl));
    trades.push({
      day: etDay(r.entryAt),
      symbol: r.symbol,
      kind: opt ? (r.optionType === "put" ? "put" : "call") : "shares",
      contract: opt ? `${r.expiration ? new Date(r.expiration + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""} $${r.strike ?? ""} ${r.optionType ?? ""}`.trim() : null,
      quantity: Number(r.entryFilledQuantity ?? r.entryQuantity) || null,
      bought: etTime(r.entryAt), buyPrice: r2(Number(r.entryFillPrice)),
      sold: closed ? etTime(r.exitAt) : null, sellPrice: closed ? r2(Number(r.exitFillPrice)) : null,
      soldDay: closed ? etDay(r.exitAt) : null,
      why: closed ? (WHY[r.exitReasonTag] || "closed") : null,
      pnl: closed ? r2(Number(r.pnl)) : null,
      open: !closed,
    });
  }
  trades.sort((a, b) => (a.day + a.bought < b.day + b.bought ? 1 : -1));           // newest first
  const byDay = new Map();
  for (const t of trades) if (!t.open) {
    const d = byDay.get(t.soldDay) || { day: t.soldDay, pnl: 0, trades: 0, won: 0 };
    d.pnl += t.pnl; d.trades += 1; if (t.pnl > 0) d.won += 1; byDay.set(t.soldDay, d);
  }
  let bal = startBalance;
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => { bal += d.pnl; return { ...d, pnl: r2(d.pnl), balance: r2(bal) }; });
  const closed = trades.filter((t) => !t.open);
  const realized = r2(closed.reduce((s, t) => s + t.pnl, 0));
  return {
    title: "Cockpit AI — live paper-trading record",
    paper: true,
    note: "Paper trading: simulated money at real market prices. Not real trades, and not investment advice.",
    generatedAt: now.toISOString(),
    start, startBalance,
    balance: r2(startBalance + realized), realized,
    closedTrades: closed.length, won: closed.filter((t) => t.pnl > 0).length,
    days, trades,
  };
}
