import { NextResponse } from "next/server";
import { tradeFetch, accountId, BROKER, optionFeePerContract } from "../tradeClient";

/* The paper account's cash. On the simulated cash account this is what
   decides whether another position can be opened today: only settled cash
   buys, and the proceeds of today's sales are not settled until tomorrow. */
export async function GET() {
  try {
    const d = await tradeFetch(`/accounts/${await accountId()}/balances`);
    const b = d?.balances ?? {};
    return NextResponse.json({
      broker: BROKER, accountType: b.account_type ?? null, optionFeePerContract: optionFeePerContract(),
      totalCash: b.total_cash ?? null,
      available: b.cash?.cash_available ?? null,
      unsettled: b.cash?.unsettled_funds ?? null,
      feesPaid: b.sim?.feesPaid ?? null, startCash: b.sim?.startCash ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
