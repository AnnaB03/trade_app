/* GET /api/scoreboard -> the public record (scoreboardLib.js), for the
   publisher on this Mac only: the page itself is a separate static site. */
import { NextResponse } from "next/server";
import { listJournal } from "../store";
import { buildScoreboard } from "../scoreboardLib";

const local = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.get("host") || "");
export async function GET(req) {
  if (!local(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  return NextResponse.json(buildScoreboard(listJournal(), { ...(q.get("start") ? { start: q.get("start") } : {}) }));
}
