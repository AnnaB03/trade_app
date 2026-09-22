#!/usr/bin/env node
/* ---------- Phase 0 of docs/opening-drive-plan.md ----------
   Re-validates, on the app's OWN Tradier feed, the two findings from the
   chat-side analysis (FMP daily/30-min bars):
     1. Yesterday's move does not predict today's gap or first 30 minutes.
     2. The first 30 minutes (9:30-10:00 ET) modestly predicts the rest of
        the session.
   Only if #2 holds up here too is app/api/openingDriveLib.js's logic worth
   trusting on the data it will actually run on in production.

   Standalone on purpose — does not import from app/api/*.js. Those files
   use ESM `export` syntax but are plain .js with no "type":"module" in
   package.json, so Node's loader would treat them as CommonJS and fail on
   that syntax if imported here. Duplicating the small Tradier fetch logic
   avoids depending on the app's module setup at all.

   Usage:
     node scripts/openingDriveBacktest.mjs [SYMBOL ...]
     node scripts/openingDriveBacktest.mjs NVDA AAPL TSLA SPY --days=40

   Needs TRADIER_TOKEN (production) or TRADIER_TOKEN_SANDBOX (delayed,
   still fine for a backtest — it's historical data either way) in the
   environment, or in .env.local next to this repo's package.json. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Minimal .env.local loader — Next.js does this automatically for the app;
// a standalone script does not, and this repo has no dotenv dependency.
function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key] == null) process.env[key] = rawVal.replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const PROD = "https://api.tradier.com/v1";
const SANDBOX = "https://sandbox.tradier.com/v1";
const prodToken = process.env.TRADIER_TOKEN;
const sandboxToken = process.env.TRADIER_TOKEN_SANDBOX;
const BASE = prodToken ? PROD : SANDBOX;
const TOKEN = prodToken || sandboxToken;

if (!TOKEN) {
  console.error("Missing TRADIER_TOKEN or TRADIER_TOKEN_SANDBOX (checked process.env and .env.local). Nothing to backtest against.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_DELAY_MS = 150;

async function tradier(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Tradier ${res.status} for ${pathAndQuery}`);
  return res.json();
}
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

async function tradingDates(symbol, days) {
  const end = new Date(), start = new Date(Date.now() - Math.ceil(days * 1.6) * 86400000); // pad for weekends/holidays
  const iso = (d) => d.toISOString().slice(0, 10);
  const d = await tradier(`/markets/history?symbol=${symbol}&interval=daily&start=${iso(start)}&end=${iso(end)}`);
  const days_ = asArray(d?.history?.day).filter((x) => x?.date);
  return days_.map((x) => x.date).slice(-days);
}

async function sessionBars(symbol, dateStr) {
  const start = encodeURIComponent(`${dateStr} 09:30`);
  const end = encodeURIComponent(`${dateStr} 16:00`);
  const d = await tradier(`/markets/timesales?symbol=${symbol}&interval=5min&start=${start}&end=${end}&session_filter=open`);
  return asArray(d?.series?.data).slice().sort((a, b) => (a.time < b.time ? -1 : 1));
}

function correlation(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}
const hitRate = (xs, ys) => 100 * xs.filter((x, i) => (x > 0) === (ys[i] > 0)).length / xs.length;

async function backtestSymbol(symbol, days) {
  const dates = await tradingDates(symbol, days);
  const rows = []; // { date, open, at10, close, drivePct, prevClosePct }
  let prevClose = null;
  for (const date of dates) {
    try {
      const bars = await sessionBars(symbol, date);
      await sleep(RATE_LIMIT_DELAY_MS);
      if (!bars.length) continue;
      const open = Number(bars[0].open ?? bars[0].price);
      const at10Bar = bars.filter((b) => b.time < `${date}T10:00:00`).pop();
      const closeBar = bars[bars.length - 1];
      const close = Number(closeBar.close ?? closeBar.price);
      if (!at10Bar || !(open > 0)) { prevClose = close; continue; }
      const at10 = Number(at10Bar.close ?? at10Bar.price);
      const drivePct = ((at10 - open) / open) * 100;
      const restPct = ((close - at10) / at10) * 100;
      const prevClosePct = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : null; // FYI only, not used below
      rows.push({ date, open, at10, close, drivePct, restPct, prevClosePct });
      prevClose = close;
    } catch (e) {
      console.error(`  ${symbol} ${date}: ${e.message} — skipped`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }
  return rows;
}

function report(name, rows) {
  if (rows.length < 5) { console.log(`\n${name}: only ${rows.length} usable sessions — too few to say anything.`); return; }
  const drive = rows.map((r) => r.drivePct);
  const rest = rows.map((r) => r.restPct);
  const corr = correlation(drive, rest);
  const hit = hitRate(drive, rest);
  const absDrive = drive.map(Math.abs).slice().sort((a, b) => a - b);
  const medianAbs = absDrive[Math.floor(absDrive.length / 2)];
  const strong = rows.filter((r) => Math.abs(r.drivePct) >= medianAbs);
  const strongHit = strong.length ? hitRate(strong.map((r) => r.drivePct), strong.map((r) => r.restPct)) : null;
  const noiseBand = 2 / Math.sqrt(rows.length);
  console.log(`\n${name}: N=${rows.length} sessions (noise band on corr ~ +/-${noiseBand.toFixed(2)})`);
  console.log(`  first-30-min -> rest-of-day:  corr=${corr.toFixed(2)}  hit-rate=${hit.toFixed(0)}%`);
  console.log(`  same, strong-drive days only: n=${strong.length}  hit-rate=${strongHit?.toFixed(0) ?? "n/a"}%`);
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number((args.find((a) => a.startsWith("--days=")) || "").split("=")[1]) || 40;
  const symbols = args.filter((a) => !a.startsWith("--"));
  if (!symbols.length) {
    console.error("Usage: node scripts/openingDriveBacktest.mjs SYMBOL [SYMBOL ...] [--days=40]");
    process.exit(1);
  }
  console.log(`Backtesting opening-drive -> rest-of-day for ${symbols.join(", ")} over ~${days} trading days on ${BASE.includes("sandbox") ? "SANDBOX (delayed, fine for history)" : "PRODUCTION"} Tradier data...`);
  const allRows = [];
  for (const symbol of symbols) {
    const rows = await backtestSymbol(symbol.toUpperCase(), days);
    report(symbol.toUpperCase(), rows);
    allRows.push(...rows);
  }
  if (symbols.length > 1) report("POOLED", allRows);
  console.log(`\nAcceptance check (docs/opening-drive-plan.md, Phase 0): pooled correlation should be positive`);
  console.log(`and outside the noise band, matching the FMP result (~0.25 pooled on NVDA/AAPL/TSLA). If it is not,`);
  console.log(`the signal does not hold on this feed and app/api/openingDriveLib.js should not be trusted as-is.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
