import { NextResponse } from "next/server";
import { dataMode } from "../tradier";

// Data-source transparency for the UI banner. Trading is always "paper" in this
// build — tradeClient.js hard-locks order routes to the Tradier sandbox.
export async function GET() {
  return NextResponse.json({
    data: dataMode(),          // "realtime" | "delayed"
    trading: "paper",
    fmp: Boolean(process.env.FMP_API_KEY),
  });
}
