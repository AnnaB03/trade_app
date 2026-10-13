import { NextResponse } from "next/server";
import { tradingHalt, haltTrading, resumeTrading } from "../riskLib";

/* The kill switch. GET shows the current halt (manual or daily-loss) and
   today's realized P&L against the limit. POST {"halted": true, "reason":
   "..."} stops new entries until POST {"halted": false}. Exits are never
   halted — see riskLib.js. */
const account = () => (Number(process.env.ACCOUNT_SIZE) > 0 ? Number(process.env.ACCOUNT_SIZE) : 1000);

export async function GET() {
  try {
    return NextResponse.json(tradingHalt({ accountSize: account() }));
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.halted === true) haltTrading(String(body.reason || "").trim() || "halted by hand");
    else if (body?.halted === false) resumeTrading();
    else return NextResponse.json({ error: "body must be {\"halted\": true, \"reason\": \"...\"} or {\"halted\": false}" }, { status: 422 });
    return NextResponse.json(tradingHalt({ accountSize: account() }));
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
