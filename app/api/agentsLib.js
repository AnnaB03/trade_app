/* ---------- The agent team (2026-10-14) ----------
   Three read-only agents, each a role in .claude/agents/, run by the Mac
   schedule through this server (a launchd job cannot read ~/Documents; this
   server can). They report; they never trade or change code. The owner:
   "yes, lets have QA and performance analyst, I also kind of like the risk
   manager/market analyst (2 in 1) idea ... morning news, overnight positions
   ... mid day news and outcomes after the big meetings we store in News".

     risk-market-analyst  brief 8:45, midday 12:30, and 15 minutes after each
                          big scheduled release (Fed, CPI, jobs, ...)
     qa                   16:20, after the close
     performance-analyst  16:35 daily; a weekly review on Fridays instead

   dueRuns() is pure (tested). runAgent() starts `claude -p --agent <role>`
   with read-only tools, writes its final message to data/reports/, and sends
   a phone notice only for lines that start with "ALERT:". */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export const ROLES = {
  "risk-market-analyst": { model: "sonnet", web: true, label: "Risk & market" },
  qa: { model: "sonnet", web: false, label: "QA" },
  "performance-analyst": { model: "sonnet", weeklyModel: "opus", web: false, label: "Performance" },
};
// Read-only tools. Bash is limited to reading commands; Edit and Write are refused outright.
export const READ_ONLY_BASH = ["npm test", "sqlite3", "python3", "curl", "git log", "git diff", "git show", "grep", "tail", "head", "cat", "ls", "date", "wc", "jq"];
export function allowedTools(role) {
  const t = ["Read", "Grep", "Glob", ...READ_ONLY_BASH.map((c) => `Bash(${c}:*)`)];
  if (ROLES[role]?.web) t.push("WebSearch", "WebFetch");
  return t;
}
export const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export const BRIEF_MIN = 8 * 60 + 45, MIDDAY_MIN = 12 * 60 + 30, QA_MIN = 16 * 60 + 20, PERF_MIN = 16 * 60 + 35;
export const EVENT_DELAY_MIN = 15;
export const MAX_RUNS_PER_DAY = 12; // a cost guard: about 6 on a normal day
// The releases worth an extra read, out of the calendar's high-impact list.
export const BIG_EVENT_RE = /FOMC|Fed Interest Rate|Fed Chair|Powell|Press Conference|CPI|Inflation Rate|Non ?Farm|Unemployment Rate|GDP|PCE|Retail Sales|PPI|Producer Price/i;

const toMin = (timeET) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeET || "").trim());
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
};
/* Event slots for today: one per distinct release time, 15 minutes after it,
   only inside the session (a pre-market release is the morning brief's job),
   and not within 20 minutes of the midday run. */
export function eventSlots(macroToday) {
  const slots = new Map();
  for (const e of macroToday || []) {
    if (!BIG_EVENT_RE.test(e?.label || "")) continue;
    const t = toMin(e.timeET); if (t == null) continue;
    const s = t + EVENT_DELAY_MIN;
    if (s < 9 * 60 + 30 + EVENT_DELAY_MIN || s >= 16 * 60) continue;
    if (Math.abs(s - MIDDAY_MIN) < 20) continue;
    slots.set(s, [...(slots.get(s) || []), e.label]);
  }
  return [...slots.entries()].map(([slot, labels]) => ({ slot, labels }));
}
/* What is due now. nowMin: ET minute of day; dow: 1 (Mon) .. 7; done: Set of
   keys already run today. Each slot runs once, on the first check at or after
   it, within its grace window. */
export function dueRuns({ nowMin, dow, macroToday = [], done = new Set(), runsToday = 0 }) {
  if (dow > 5 || runsToday >= MAX_RUNS_PER_DAY) return [];
  const want = [
    { role: "risk-market-analyst", mode: "brief", slot: BRIEF_MIN, grace: 40 },
    { role: "risk-market-analyst", mode: "midday", slot: MIDDAY_MIN, grace: 45 },
    ...eventSlots(macroToday).map((e) => ({ role: "risk-market-analyst", mode: "event", slot: e.slot, grace: 30, labels: e.labels })),
    { role: "qa", mode: "daily", slot: QA_MIN, grace: 120 },
    { role: "performance-analyst", mode: dow === 5 ? "weekly" : "daily", slot: PERF_MIN, grace: 120 },
  ];
  return want
    .map((w) => ({ ...w, key: `${w.role}|${w.mode}|${w.slot}` }))
    .filter((w) => nowMin >= w.slot && nowMin - w.slot <= w.grace && !done.has(w.key));
}

export function taskPrompt({ role, mode, labels, dateET, timeET }) {
  const when = `It is ${dateET} ${timeET} ET.`;
  if (role === "risk-market-analyst") {
    if (mode === "event") return `${when} Task: event — ${labels.join("; ")}. Read the outcome and the market's reaction, and what it means for the open positions and today's ideas.`;
    return `${when} Task: ${mode}. Write the ${mode === "brief" ? "morning brief" : "midday check"}.`;
  }
  if (role === "qa") return `${when} Task: daily QA of today's session (${dateET}).`;
  return `${when} Task: ${mode === "weekly" ? "weekly review of this week" : "daily report for today"} (${dateET}).`;
}

export const ALERT_RE = /^\s*(?:[-*]\s*)?\**ALERT:?\**\s*(.+)$/gim;
export const alertsIn = (text) => [...String(text || "").matchAll(ALERT_RE)].map((m) => m[1].trim());

export const REPORT_DIR = path.join(process.cwd(), "data", "reports");
export const reportName = ({ dateET, timeET, role, mode }) => `${dateET}_${String(timeET).replace(":", "")}_${role}_${mode}.md`;

const running = new Set();
export const isRunning = (role) => running.has(role);

/* Starts one agent and returns at once; the report is written when it ends.
   25-minute limit. The claude binary is found on PATH or at Homebrew's path. */
export function runAgent({ role, mode, labels = [], dateET, timeET, onDone = () => {} }) {
  if (!ROLES[role]) throw new Error(`unknown role ${role}`);
  if (running.has(role)) return { started: false, reason: `${role} is already running` };
  running.add(role);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, reportName({ dateET, timeET, role, mode }));
  const model = mode === "weekly" && ROLES[role].weeklyModel ? ROLES[role].weeklyModel : ROLES[role].model;
  const args = ["-p", taskPrompt({ role, mode, labels, dateET, timeET }), "--agent", role, "--model", model,
    "--allowedTools", ...allowedTools(role), "--disallowedTools", ...DISALLOWED_TOOLS, "--output-format", "text",
    // The server log and the schedule's log live outside the repo.
    "--add-dir", "/tmp", path.join(process.env.HOME || "", "Library", "Logs")];
  const bin = process.env.CLAUDE_BIN || (fs.existsSync("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : "claude");
  /* A clean environment, not this server's: the server carries .env.local
     (halts switched off, a margin account, ...), and the QA agent's first run
     reported 6 failing tests that only fail under those settings. */
  const env = Object.fromEntries(["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const child = spawn(bin, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const kill = setTimeout(() => child.kill("SIGTERM"), 25 * 60000);
  const finish = (code) => {
    clearTimeout(kill); running.delete(role);
    const body = out.trim() || `(no report — the agent exited with code ${code})\n\n${err.trim().slice(-2000)}`;
    const header = `<!-- role: ${role} | mode: ${mode} | model: ${model} | started: ${dateET} ${timeET} ET | exit: ${code} -->\n`;
    try { fs.writeFileSync(file, header + body + "\n"); } catch {}
    onDone({ role, mode, file, code, body, header, alerts: alertsIn(body) });
  };
  child.on("close", finish);
  child.on("error", (e) => { err += String(e?.message || e); finish(-1); });
  return { started: true, file };
}

// Reports, newest first: [{ file, role, mode, dateET, timeET, body }]
export function listReports({ limit = 30 } = {}) {
  let names = [];
  try { names = fs.readdirSync(REPORT_DIR).filter((n) => n.endsWith(".md")); } catch { return []; }
  return names.sort().reverse().slice(0, limit).map((n) => {
    const [dateET, hhmm, role, modeMd] = n.split("_");
    let body = ""; try { body = fs.readFileSync(path.join(REPORT_DIR, n), "utf8"); } catch {}
    return { file: n, role, mode: modeMd.replace(/\.md$/, ""), dateET, timeET: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, body: body.replace(/^<!--.*?-->\n/, ""), meta: (/^<!--(.*?)-->/.exec(body) || [])[1]?.trim() ?? null };
  });
}
