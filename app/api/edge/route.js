import { NextResponse } from "next/server";
import { listJournal } from "../store";
import { readBaseline, isLegacy } from "../ledgerLib";
import { edgeReport } from "../edgeLib";
import { accountSize } from "../accountLib";
import { RISK_PER_TRADE_PCT } from "../order/entryRules";

/* The realized record, read the way a trader reads a statement — see
   edgeLib.js. ?days=N limits it to recent closes (default: everything since
   the fresh start). The verdicts are what autotrade's edge gate enforces. */
export async function GET(req) {
  try {
    const days = Number(new URL(req.url).searchParams.get("days")) || 0;
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
    const baseline = readBaseline();
    const rows = listJournal().filter((r) => !isLegacy(r, baseline) && (!cutoff || new Date(r.exitAt || r.createdAt).getTime() >= cutoff));
    const account = accountSize();
    return NextResponse.json({ account, days: days || null, edgeGate: process.env.EDGE_GATE !== "false", since: baseline.freshStartAt ?? null, ...edgeReport(rows, { rUsd: (account * RISK_PER_TRADE_PCT) / 100 }) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
