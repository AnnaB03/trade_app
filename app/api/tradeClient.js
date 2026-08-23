/* Phase 3 trading client — SANDBOX ONLY.
   The lock below is hard-coded per the build brief: no env var may point order
   routes at live Tradier in this build. */
const SANDBOX = "https://sandbox.tradier.com/v1";
const TRADE_BASE = process.env.TRADIER_TRADE_BASE || SANDBOX;
const TOKEN = process.env.TRADIER_TRADE_TOKEN || process.env.TRADIER_TOKEN_SANDBOX || process.env.TRADIER_TOKEN;

// returns an error message when trading must be refused; null when safe
export function sandboxLockError() {
  if (TRADE_BASE !== SANDBOX) return "Live trading is disabled in this build.";
  return null;
}

export async function tradeFetch(path, { method = "GET", form } = {}) {
  if (!TOKEN) throw new Error("Server is missing TRADIER_TRADE_TOKEN (or TRADIER_TOKEN_SANDBOX) — set it in .env.local.");
  const res = await fetch(`${SANDBOX}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let d; try { d = JSON.parse(text); } catch { d = null; }
  if (res.status === 401) throw new Error("Tradier rejected the trading token (401) — check TRADIER_TRADE_TOKEN.");
  if (!res.ok) {
    const e = d?.errors?.error;
    throw new Error(`Tradier ${res.status}: ${Array.isArray(e) ? e.join("; ") : e || text.slice(0, 200)}`);
  }
  return d ?? {};
}

let cachedAccount = null;
export async function accountId() {
  if (process.env.TRADIER_ACCOUNT_ID) return process.env.TRADIER_ACCOUNT_ID;
  if (cachedAccount) return cachedAccount;
  const d = await tradeFetch("/user/profile");
  const acct = d?.profile?.account;
  const first = Array.isArray(acct) ? acct[0] : acct;
  cachedAccount = first?.account_number || null;
  if (!cachedAccount) throw new Error("No sandbox account found — set TRADIER_ACCOUNT_ID in .env.local (shown on Tradier's API Access page).");
  return cachedAccount;
}

export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
