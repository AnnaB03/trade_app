import { NextResponse } from "next/server";
import { dataMode } from "../tradier";
import { BROKER } from "../tradeClient";
import { accountSize } from "../accountLib";
import { RISK_PER_TRADE_PCT, learningMode, CONFIRM_BARS, FADES_PER_SYMBOL_DAY, FLIP_WAIT_MIN, LEARNING_LAST_ENTRY_MIN, LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY } from "../order/entryRules";
import { MAX_LOSS_PCT, HARD_LOSS_PCT, PROFIT_TAKE_PCT, profitExitMode } from "../order/exitRules";
import { DAILY_LOSS_LIMIT_PCT } from "../riskLib";
import { STOP_FLOOR_PCT, STOP_CAP_PCT } from "../swingLib";

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
    // The live rule values, read from the code that applies them, so the
    // agents and the UI can check them against what was agreed (RULES.md).
    rules: {
      learningMode: learningMode(),
      riskPerTradePct: RISK_PER_TRADE_PCT, maxLossPct: MAX_LOSS_PCT, maxLossAppliesTo: "shares only (options: the stop)", dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
      optionStopPct: { flat: HARD_LOSS_PCT.OPTION, floor: STOP_FLOOR_PCT, cap: STOP_CAP_PCT },
      profitExits: profitExitMode(), profitTakePct: PROFIT_TAKE_PCT,
      entryConfirm: process.env.ENTRY_CONFIRM || "ab", confirmBars: CONFIRM_BARS,
      fadesPerSymbolDay: FADES_PER_SYMBOL_DAY, flipWaitMin: FLIP_WAIT_MIN,
      sameDayLastEntryET: `${Math.floor(LEARNING_LAST_ENTRY_MIN / 60)}:${String(LEARNING_LAST_ENTRY_MIN % 60).padStart(2, "0")}`,
      maxEntriesPerSymbolDay: LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY,
      pdt: learningMode() ? "recorded, not enforced (paper, learning mode)" : "enforced",
    },
  });
}
