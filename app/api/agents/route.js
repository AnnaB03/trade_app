/* The agent team (agentsLib.js).
   GET  /api/agents                -> reports, newest first, and what is running
   GET  /api/agents?tick=1         -> start whatever is due now (the Mac schedule calls this every minute)
   POST /api/agents?run=<role>&mode=<mode>  -> start one now (the Team tab's "Run now")
   Only from this machine: an agent run is billed. */
import { NextResponse } from "next/server";
import { ROLES, dueRuns, runAgent, listReports, isRunning } from "../agentsLib";
import { macroEvents } from "../eventsLib";
import { kvGet, kvSet } from "../store";
import { notify } from "../notifyLib";
import fs from "fs";
import { ingestNewsIdeas, stripIdeasBlock } from "../newsIdeasLib";
import { shortDatedContract } from "../contractLib";
import { tradier, asArray } from "../tradier";
import { appendIdea } from "../store";
import { accountSize } from "../accountLib";

// News ideas are same-day, so none are taken from a report written after 15:00 ET.
const NEWS_IDEAS_UNTIL_MIN = 15 * 60;
async function lastPrice(symbol) {
  const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
  const q = asArray(d?.quotes?.quote)[0];
  return Number(q?.last) || null;
}
/* The analyst's ideas block (newsIdeasLib.js) goes to the ledger as strategy
   "news"; the report keeps a plain summary of what was accepted and refused. */
async function takeNewsIdeas({ body, header, file, mode, nowMin }) {
  if (!/```ideas-json/i.test(body)) return;
  let note;
  if (nowMin >= NEWS_IDEAS_UNTIL_MIN) note = "Ideas for the Cockpit: none taken (written after 15:00 ET; news ideas are same-day).";
  else {
    const acct = accountSize();
    const r = await ingestNewsIdeas(body, {
      quote: lastPrice, appendIdea, accountSize: acct, source: `risk-market-analyst ${mode}`,
      pickContract: (sym, type) => shortDatedContract(sym, type, { accountSize: acct }),
    });
    note = [
      `Ideas for the Cockpit: ${r.accepted.length} accepted${r.accepted.length ? ` (${r.accepted.map((a) => `${a.symbol} ${a.action} ${a.occ}`).join("; ")})` : ""}.`,
      ...r.rejected.map((x) => `- refused: ${x}`),
    ].join("\n");
  }
  try { fs.writeFileSync(file, header + stripIdeasBlock(body) + "\n\n" + note + "\n"); } catch {}
}

const DONE_KEY = "agent_runs";
const etParts = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;
  return { dateET: `${p.year}-${p.month}-${p.day}`, timeET: `${hh}:${p.minute}`, nowMin: Number(hh) * 60 + Number(p.minute), dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1 };
};
const local = (req) => {
  const h = req.headers.get("host") || "";
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
};
function start({ role, mode, labels, dateET, timeET, key }) {
  return runAgent({
    role, mode, labels, dateET, timeET,
    onDone: ({ alerts, code, body, header, file }) => {
      if (role === "risk-market-analyst") takeNewsIdeas({ body, header, file, mode, nowMin: etParts().nowMin }).catch((e) => console.error("[agents] news ideas failed:", e));
      if (alerts.length) notify(`${ROLES[role].label}: ${alerts.length} alert${alerts.length > 1 ? "s" : ""}`, alerts.join("\n").slice(0, 900), { priority: "high", tags: ["warning"] }).catch(() => {});
      if (code !== 0) console.error(`[agents] ${role} ${mode} exited ${code}`);
    },
  });
}

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  if (q.get("tick")) {
    if (!local(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
    const t = etParts();
    const state = kvGet(DONE_KEY);
    const done = new Set(state?.day === t.dateET ? state.keys : []);
    let macroToday = [];
    try { macroToday = (await macroEvents()).filter((e) => e.date === t.dateET); } catch {}
    const due = dueRuns({ nowMin: t.nowMin, dow: t.dow, macroToday, done, runsToday: done.size });
    const started = [];
    for (const d of due) {
      if (isRunning(d.role)) continue;
      const r = start({ ...d, dateET: t.dateET, timeET: t.timeET });
      if (r.started) { done.add(d.key); started.push(d.key); }
    }
    kvSet(DONE_KEY, { day: t.dateET, keys: [...done] });
    return NextResponse.json({ ...t, started, ranToday: [...done] });
  }
  return NextResponse.json({
    roles: Object.fromEntries(Object.entries(ROLES).map(([r, v]) => [r, { label: v.label, running: isRunning(r) }])),
    reports: listReports({ limit: Number(q.get("limit")) || 30 }),
  });
}

export async function POST(req) {
  if (!local(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const role = q.get("run"), mode = q.get("mode") || (role === "risk-market-analyst" ? "brief" : "daily");
  if (!ROLES[role]) return NextResponse.json({ error: `unknown role ${role}` }, { status: 400 });
  const t = etParts();
  const r = start({ role, mode, labels: q.get("labels") ? [q.get("labels")] : [], dateET: t.dateET, timeET: t.timeET });
  return NextResponse.json(r, { status: r.started ? 202 : 409 });
}
