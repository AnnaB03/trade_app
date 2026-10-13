/* ---------- Push notifications, through ntfy ----------
   The automation runs unattended. The log is the record; this is the thing
   that reaches a phone when something happened: a fill, an exit with its
   P&L, a halt, the autopilot going dark. ntfy.sh needs no account — pick a
   topic name nobody would guess, set NTFY_TOPIC to it, and subscribe to it
   in the ntfy app. NTFY_URL points at a self-hosted server if wanted.
   No topic set = every call is a silent no-op, so nothing here can break a
   trade. Never throws; never waits more than a few seconds. */
const URL = (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
const TOPIC = process.env.NTFY_TOPIC;

export const notifyEnabled = () => Boolean(TOPIC);

// title: short, plain ASCII (ntfy carries it as an HTTP header). body: anything.
// priority: min | low | default | high | urgent. tags: ntfy emoji shortcodes.
export async function notify(title, body, { priority = "default", tags = [] } = {}) {
  if (!TOPIC) return false;
  try {
    const r = await fetch(`${URL}/${encodeURIComponent(TOPIC)}`, {
      method: "POST",
      body: String(body ?? ""),
      headers: {
        Title: String(title ?? "Cockpit").replace(/[^\x20-\x7e]/g, "").slice(0, 120),
        Priority: priority,
        ...(tags.length ? { Tags: tags.join(",") } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const usd = (v) => (v < 0 ? "-$" : "+$") + Math.abs(Number(v) || 0).toFixed(0);

export const notifyBought = ({ symbol, instrument, quantity, price, playbook }) =>
  notify("Bought", `${quantity} x ${instrument || symbol} @ $${Number(price).toFixed(2)}${playbook === "intraday" ? " (same-day)" : ""}`, { tags: ["inbox_tray"] });

export const notifySold = ({ symbol, instrument, quantity, price, pnl, tag }) =>
  notify(pnl >= 0 ? "Sold, gain" : "Sold, loss",
    `${quantity ?? ""} x ${instrument || symbol} @ $${Number(price).toFixed(2)}  ${usd(pnl)}  (${tag || "closed"})`,
    { priority: pnl < 0 ? "high" : "default", tags: [pnl >= 0 ? "chart_with_upwards_trend" : "chart_with_downwards_trend"] });

export const notifyHalt = ({ kind, reason }) =>
  notify(`Trading stopped: ${kind.replace(/_/g, " ")}`, reason, { priority: "high", tags: ["octagonal_sign"] });
