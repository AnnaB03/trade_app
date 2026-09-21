import { NextResponse } from "next/server";
import { tradeFetch, accountId, asArray as asArrTrade } from "../tradeClient";
import { tradier, asArray } from "../tradier";
import { parseOcc } from "../../lib/orders";
import { listJournal } from "../store";

/* Live positions from the Tradier sandbox account, enriched with a current
   quote (for unrealized P&L) and cross-referenced with the open journal
   entry for that contract/symbol, if this app is the one that opened it —
   that's what lets the Positions view show the original plan (thesis,
   invalidation, target) next to a live position instead of just a bare
   quantity. Positions opened outside this app (or before the journal
   existed) still show up, just without the journal context. */
export async function GET() {
  try {
    const acct = await accountId();
    const posRaw = asArrTrade((await tradeFetch(`/accounts/${acct}/positions`))?.positions?.position);
    if (!posRaw.length) return NextResponse.json({ positions: [] });

    const openJournal = listJournal().filter((j) => j.status === "open");

    const symbols = [...new Set(posRaw.map((p) => p.symbol))];
    const quoteBySym = {};
    try {
      const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      for (const q of asArray(d?.quotes?.quote)) quoteBySym[q.symbol] = q;
    } catch {}

    const positions = posRaw.map((p) => {
      const parsed = parseOcc(p.symbol);
      const isOption = Boolean(parsed);
      const underlying = parsed?.underlying ?? p.symbol;
      const q = quoteBySym[p.symbol];
      const last = q?.last != null ? Number(q.last) : null;
      const costBasis = Number(p.cost_basis) || null;
      const qty = Number(p.quantity) || 0;
      const mult = isOption ? 100 : 1;
      const marketValue = last != null ? last * qty * mult : null;
      const unrealizedPnl = costBasis != null && marketValue != null ? marketValue - costBasis : null;
      const journalEntry = openJournal.find((j) =>
        isOption ? j.occ === p.symbol : (j.vehicle === "SHARES" && j.symbol === p.symbol)
      );
      return {
        symbol: p.symbol, underlying, vehicle: isOption ? "OPTION" : "SHARES",
        strike: parsed?.strike ?? null, expiration: parsed?.expiration ?? null, optionType: parsed?.type ?? null,
        quantity: qty, costBasis, last, marketValue, unrealizedPnl,
        journal: journalEntry ? {
          id: journalEntry.id, thesis: journalEntry.thesis, entryTrigger: journalEntry.entryTrigger,
          invalidation: journalEntry.invalidation, target: journalEntry.target, catalyst: journalEntry.catalyst,
          conviction: journalEntry.conviction, entryAt: journalEntry.entryAt, entryLimitPrice: journalEntry.entryLimitPrice,
        } : null,
      };
    });

    return NextResponse.json({ positions });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e), positions: [] }, { status: 502 });
  }
}
