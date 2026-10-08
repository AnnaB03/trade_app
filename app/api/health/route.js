import { NextResponse } from "next/server";
import { listJournal, listIdeas } from "../store";
import { getClock } from "../clockLib";
import { tradeFetch, accountId, asArray, BROKER } from "../tradeClient";

/* End-to-end health, for the scheduled jobs to gate on.

   The order routes already return real status codes — 502 on a thrown error,
   404 when the ledger is empty. The gap was never the codes: it was that the
   jobs read only the response BODY and ignored the status, so when autoexit
   threw "reservedQuantities is not defined" it answered 502 with an error body
   and every exit check silently became a no-op while the job reported nothing.

   This gives a single call that fails LOUDLY — 503 and ok:false — when any leg
   the autopilot depends on is down: the journal store, the market data feed, or
   the broker. Check this first; if it is not 200, say so and do not treat a
   quiet market as quiet. */
export async function GET() {
  const checks = {};
  const t0 = Date.now();

  try {
    const j = listJournal(); const i = listIdeas();
    checks.store = { ok: Array.isArray(j) && Array.isArray(i), journalRows: j.length, ideas: i.length,
      openRows: j.filter((r) => r.status === "open").length,
      frozenRows: j.filter((r) => r.status === "open" && r.frozen).length };
  } catch (e) { checks.store = { ok: false, error: String(e.message || e) }; }

  {
    const c = await getClock();
    checks.marketData = { ok: c.state !== "unknown", state: c.state, ...(c.stale ? { stale: true, staleSeconds: c.staleSeconds } : {}), ...(c.state === "unknown" ? { error: c.error } : {}) };
  }

  try {
    const acct = await accountId();
    const d = await tradeFetch(`/accounts/${acct}/positions`);
    const pos = asArray(d?.positions?.position);
    checks.broker = { ok: true, broker: BROKER, account: acct, positions: pos.length };
  } catch (e) { checks.broker = { ok: false, error: String(e.message || e) }; }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { ok, ms: Date.now() - t0, checks, at: new Date().toISOString() },
    { status: ok ? 200 : 503 }
  );
}
