import { NextResponse } from "next/server";
import { tradier } from "../tradier";

/* Market clock via Tradier /markets/clock.
   state: "open" | "closed" | "premarket" | "postmarket" | "unknown".
   Cached 30s server-side; the UI treats "unknown" as open so a clock outage
   never freezes the app. */

let cached = null; // { at, data }

export async function GET() {
  if (cached && Date.now() - cached.at < 30000) return NextResponse.json(cached.data);
  try {
    const d = await tradier(`/markets/clock`);
    const c = d?.clock || {};
    const data = {
      state: c.state || "unknown",
      description: c.description || "",
      date: c.date || null,
      next_change: c.next_change || null,
      next_state: c.next_state || null,
    };
    cached = { at: Date.now(), data };
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ state: "unknown", description: "", error: String(e.message || e) });
  }
}
