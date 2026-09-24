import { NextResponse } from "next/server";
import { tradier } from "../tradier";
import { scanSweeps, DEFAULT_SWEEP_SYMS } from "../sweepsLib";

/* Liquidity-sweep scan (no LLM, cheap): per symbol, its unswept swing lows,
   any live LIMIT / RECLAIM setup, and its own daily backtest. New setups are
   logged to the ideas ledger (log=false to just look). ?symbols=A,B,C
   overrides the default list; ?account= sizes the shares like Ideas does. */
export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const symbols = p.get("symbols") ? p.get("symbols").split(",") : DEFAULT_SWEEP_SYMS;
  const account = Number(p.get("account")) > 0 ? Number(p.get("account")) : (Number(process.env.ACCOUNT_SIZE) > 0 ? Number(process.env.ACCOUNT_SIZE) : 1000);
  let marketState = "unknown";
  try { marketState = (await tradier("/markets/clock"))?.clock?.state || "unknown"; } catch {}
  try {
    const data = await scanSweeps({ symbols, account, log: p.get("log") !== "false", marketState });
    return NextResponse.json({ ...data, marketState, defaults: DEFAULT_SWEEP_SYMS });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
