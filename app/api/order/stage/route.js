import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";

// Stage = run all gates + Tradier preview. Never places. body.equity present
// -> plain shares path; body.legs present -> options path.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  try {
    const vet = body?.equity ? await vetEquityOrder(body, { preview: true }) : await vetOrder(body, { preview: true });
    if (vet.error) {
      return NextResponse.json(
        { error: vet.error, gates: vet.gates ?? null, needs_ack: vet.needs_ack ?? false, figure: vet.figure ?? null },
        { status: vet.status }
      );
    }
    let preview = null;
    try {
      const d = await submitOrder(vet.form);
      preview = d?.order ?? d;
    } catch (e) {
      preview = { unavailable: true, error: String(e.message || e) };
    }
    return NextResponse.json({ gates: vet.gates, preview, computed: vet.computed });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
