/* Market DATA client (quotes, chains, expirations, history).
   Data prefers PRODUCTION Tradier — a funded-account token gives real-time quotes;
   the sandbox is 15-min delayed. This is the ONE feed: decisions, valuations and
   the simulated fills in simBroker.js all read it, because a real account has no
   second, slower feed to compare against. Order routes never use this client:
   they go through tradeClient.js, which is paper-only.

   Token/base resolution:
   - TRADIER_TOKEN set        → production base, real-time data
   - only TRADIER_TOKEN_SANDBOX → sandbox base, delayed data
   - TRADIER_BASE overrides the base explicitly (rarely needed now) */
const PROD = "https://api.tradier.com/v1";
const SANDBOX = "https://sandbox.tradier.com/v1";

const prodToken = process.env.TRADIER_TOKEN;
const sandboxToken = process.env.TRADIER_TOKEN_SANDBOX;
const BASE = process.env.TRADIER_BASE || (prodToken ? PROD : SANDBOX);
const isSandbox = BASE.includes("sandbox");
const TOKEN = isSandbox ? (sandboxToken || prodToken) : (prodToken || sandboxToken);

// "realtime" only when we're on the production host with a production token
export const dataMode = () => (!isSandbox && prodToken ? "realtime" : "delayed");

// timeoutMs bounds a single call. Callers that loop over many symbols need
// this: without it one slow response stalls a whole route, and autotrade runs
// on a 15-minute cron that must finish well inside its own window.
// Every call is bounded (DEFAULT_TIMEOUT_MS unless the caller sets its own): on
// 2026-11-19 one unbounded 1-minute-bars call took 10 s+ and, repeated per
// triggered idea, stretched entry checks to 80-115 s against a 120 s limit.
export const DEFAULT_TIMEOUT_MS = 8000;
export async function tradier(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!TOKEN) throw new Error("Server is missing TRADIER_TOKEN (production, real-time) or TRADIER_TOKEN_SANDBOX — set it in your environment / Vercel project settings.");
  // A profiled entry check (autotrade ?profile=true) collects every call's path and time here.
  const trace = globalThis.__tradierTrace, t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    cache: "no-store",
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (res.status === 401) throw new Error(`Tradier rejected the token (401) for ${isSandbox ? "sandbox" : "production"} data. Production needs TRADIER_TOKEN from a funded brokerage account; sandbox needs TRADIER_TOKEN_SANDBOX.`);
  if (trace) trace.push({ path: path.split("?")[0], q: path, ms: Date.now() - t0, status: res.status });
  if (!res.ok) throw new Error(`Tradier responded ${res.status}`);
  return res.json();
}
export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
