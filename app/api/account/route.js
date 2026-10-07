import { NextResponse } from "next/server";
import { tradeFetch, accountId, BROKER, optionFeePerContract } from "../tradeClient";
import { listJournal } from "../store";
import { readBaseline, isLegacy } from "../ledgerLib";

/* The paper account at a glance, for the Journal tab and the book report.
   Cash: on the simulated cash account this is what decides whether another
   position can be opened today — only settled cash buys, and the proceeds of
   today's sales are not settled until tomorrow.
   Ledger: closed trades since the fresh start in data/baseline.json, net of
   fees. Open P&L is not here; it needs live quotes (see /api/positions). */
export async function GET() {
  try {
    const d = await tradeFetch(`/accounts/${await accountId()}/balances`);
    const b = d?.balances ?? {};
    const baseline = readBaseline();
    const rows = listJournal().filter((r) => !isLegacy(r, baseline));
    const done = rows.filter((r) => r.status === "closed" && typeof r.pnl === "number" && !r.excludeFromGoal);
    const wins = done.filter((r) => r.pnl > 0).length;
    return NextResponse.json({
      broker: BROKER, accountType: b.account_type ?? null, optionFeePerContract: optionFeePerContract(),
      totalCash: b.total_cash ?? null,
      available: b.cash?.cash_available ?? null,
      unsettled: b.cash?.unsettled_funds ?? null,
      feesPaid: b.sim?.feesPaid ?? null, startCash: b.sim?.startCash ?? null,
      ledger: {
        since: baseline.freshStartAt ?? null,
        realized: done.reduce((s, r) => s + r.pnl, 0),
        closes: done.length, wins, losses: done.length - wins,
        open: rows.filter((r) => r.status === "open").length,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
