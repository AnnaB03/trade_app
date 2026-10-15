import { NextResponse } from "next/server";
import { listJournal, listIdeas } from "../store";
import { reconcileJournal } from "../journalReconcile";
import { readBaseline } from "../ledgerLib";
import { exitPlan } from "../order/exitRules";
import { accountSize } from "../accountLib";

// Every REAL order this app placed (open -> close), auto-linked to its
// originating idea when there was one. See app/api/journalLib.js. Reads
// fills / stop-outs / expired entries back from Tradier first (throttled),
// so autopilot trades close themselves out here — see journalReconcile.js.
export async function GET(req) {
  /* ?force=true bypasses the 60-second throttle. Needed because a close that
     fills a few seconds after submit leaves its row with no exit price until
     the next unthrottled pass, and there was previously no way to ask for one:
     AVGO 10/30 $360c filled at $15.25 while its journal row still read null,
     and every call to this route answered {skipped: true}. */
  const force = new URL(req.url).searchParams.get("force") === "true";
  const reconcile = await reconcileJournal({ force });
  // exitPlan: what each position is waiting for to be sold (exitRules.exitPlan).
  const acct = accountSize();
  const ideaById = new Map(listIdeas().map((i) => [i.id, i]));
  const fromIdea = (e) => { const i = ideaById.get(e.ideaId); return { delta: i?.leg?.delta ?? null, underlyingAtEntry: i?.triggerPrice ?? i?.entryPrice ?? e.entryPriceAtIdea ?? null }; };
  return NextResponse.json({ entries: listJournal().map((e) => ({ ...e, exitPlan: exitPlan(e, { accountSize: acct, ...fromIdea(e) }) })), reconcile, freshStartAt: readBaseline().freshStartAt ?? null });
}
