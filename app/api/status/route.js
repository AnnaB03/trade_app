import { NextResponse } from "next/server";
import { dataMode } from "../tradier";
import { BROKER } from "../tradeClient";
import { accountSize } from "../accountLib";

// Data-source transparency for the UI banner. Trading is always paper in this
// build: "sim" is the simulated cash account filled on real-time quotes,
// "sandbox" the Tradier sandbox (see tradeClient.js).
export async function GET() {
  return NextResponse.json({
    data: dataMode(),          // "realtime" | "delayed"
    trading: "paper",
    broker: BROKER,
    accountSize: accountSize(),   // the one size every rule and every idea is sized from
    fmp: Boolean(process.env.FMP_API_KEY),
  });
}
