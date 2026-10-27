"use client";
import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { journalStats, todayStr } from "../lib/metrics";

const pctFmt = (v) => v == null ? "—" : (v * 100).toFixed(0) + "%";
const usd = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const blank = () => ({ date: todayStr(), symbol: "", structure: "", direction: "bull", premium: "bought", entryIv: "", thesis: "", status: "open", pnl: "" });

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

// latest stored IV snapshot for a symbol (written by the Chain & Risk tab)
function latestIv(sym) {
  try {
    const store = JSON.parse(localStorage.getItem("iv_history") || "{}");
    const list = store[sym?.toUpperCase()] || [];
    return list.length ? list[list.length - 1].iv : null;
  } catch { return null; }
}

// Close an open live position: quantity + limit price (both editable,
// defaulted from the position) and a required reason — the same
// preview-then-send pattern as the Ideas tab's order buttons, ending in a
// real (paper) closing order once you confirm. The server derives which
// Tradier side to use (sell / buy_to_cover / sell_to_close) from the actual
// live position, so a mislabeled close can't open the opposite exposure.
/* Sell a position by hand: one button, at the price it can be sold for now.

   It used to be three steps — type a reason, Preview, then Send — and the
   Preview button was silently disabled until a reason was typed, so a share
   sale could look broken (2026-10-14: "I can't sell stocks myself"). The
   server path was fine. The reason is now optional, the price defaults to the
   live bid, and the result says whether the sale filled or is resting. */
/* What the Cockpit is waiting for to sell this position (exitRules.exitPlan,
   computed on the server from the live rules). */
const money = (v) => (v < 0 ? "−$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US");
function ExitPlanCell({ plan, symbol, faded }) {
  if (!plan) return <span className="muted">—</span>;
  const quick = plan.profit.find((p) => p.kind === "take_usd");
  const take = plan.profit.find((p) => p.kind === "take");
  const target = plan.profit.find((p) => p.kind === "target");
  const trail = plan.profit.find((p) => p.kind === "trail");
  return (
    <div style={{ fontSize: 12, lineHeight: 1.45, opacity: faded ? 0.6 : 1 }}
      title="The Cockpit sells automatically at the first of these. Profit: anything up over $50 at the bid, the option at +50%, or the stock at the idea's target. Loss: the option stop or the max-loss sale, whichever comes first.">
      {quick && <div className="up">over +${quick.usd} at the bid</div>}
      {take && <div className="up">{quick ? "or " : ""}+{take.pct}% → ${take.price.toFixed(2)} ({money(take.usd)})</div>}
      {target && <div>or {symbol} {target.above ? "≥" : "≤"} ${target.underlying}{target.estUsd != null && <> <span className="up">(≈ {money(target.estUsd)})</span>{target.takeFirst && <span className="muted"> · +50% comes first</span>}</>}</div>}
      {trail && <div className="muted">trail from +{trail.armPct}%</div>}
      {plan.loss && <div className="muted">stop ${plan.loss.price.toFixed(2)} ({money(plan.loss.usd)}){plan.loss.byMaxLoss ? " max loss" : ""}</div>}
      {plan.eod && <div className="muted">sold at 15:45 regardless</div>}
    </div>
  );
}

function ClosePositionControl({ position, onClosed }) {
  const [qty, setQty] = useState(String(Math.abs(position.quantity)));
  const [price, setPrice] = useState(position.last != null ? Number(position.last).toFixed(2) : "");
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ status: "idle" });
  const isOption = position.vehicle === "OPTION";
  const note = reason.trim() || "Sold by hand from the Journal tab";

  const body = () => isOption
    ? { legs: [{ action: "sell", type: position.optionType, strike: String(position.strike), premium: price, qty: Number(qty), occ: position.symbol }], closing: true, limit_price: Number(price), outcome_note: note, outcome_tag: "manual" }
    : { equity: { symbol: position.underlying, quantity: Number(qty), price: Number(price) }, closing: true, outcome_note: note, outcome_tag: "manual" };

  const sell = async () => {
    if (!(Number(qty) > 0) || !(Number(price) > 0)) { setState({ status: "error", msg: "Enter a quantity and a price." }); return; }
    setState({ status: "placing" });
    try {
      const r = await fetch("/api/order/place", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "The sale was refused");
      // Did it fill? The position is gone from the account if it did.
      const pos = await fetch("/api/positions").then((x) => x.json()).catch(() => null);
      const still = pos?.positions?.find((p) => p.symbol === position.symbol);
      setState({
        status: "placed",
        msg: still
          ? `Sell order resting at $${Number(price).toFixed(2)} — not filled yet. It fills if the bid reaches your price; to sell immediately, use the current bid.`
          : `Sold ${qty} ${isOption ? "contract" + (Number(qty) === 1 ? "" : "s") : "share" + (Number(qty) === 1 ? "" : "s")} at about $${Number(price).toFixed(2)}.`,
      });
      onClosed?.();
    } catch (e) { setState({ status: "error", msg: e.message }); }
  };

  if (state.status === "placed") return <div className="safe" style={{ fontSize: 12.5, padding: "8px 10px", marginTop: 6 }}>✓ {state.msg}</div>;

  const atBid = position.last != null && Number(price) === Number(Number(position.last).toFixed(2));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input className="in" style={{ width: 56, padding: "3px 6px", fontSize: 12 }} inputMode="numeric" value={qty} disabled={state.status === "placing"}
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Quantity" />
        <span className="mono muted" style={{ fontSize: 12 }}>@ $</span>
        <input className="in" style={{ width: 76, padding: "3px 6px", fontSize: 12 }} inputMode="decimal" value={price} disabled={state.status === "placing"}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Limit price" />
        <button className="btn" onClick={sell} disabled={state.status === "placing"}>
          {state.status === "placing" ? "Selling…" : `Sell ${qty || ""} now`}
        </button>
      </div>
      <input className="in" style={{ padding: "3px 6px", fontSize: 12 }} placeholder="Why are you selling? (optional — it helps the review later)" value={reason}
        disabled={state.status === "placing"} onChange={(e) => setReason(e.target.value)} />
      <span className="mono muted" style={{ fontSize: 11 }}>
        {atBid ? "Price is the current bid, so this sells immediately." : "Above the bid, the order rests until the market reaches your price."}
      </span>
      {state.status === "error" && <div className="err" style={{ fontSize: 12.5 }}>{state.msg}</div>}
    </div>
  );
}

const REFRESH_MS = 30000;
const usd0 = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

const clockTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "never";
const minutesAgo = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity;
const marketHoursNow = () => {
  const p = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
  const [day, hm] = p.split(" "); const [h, m] = hm.split(":").map(Number); const t = (h % 24) * 60 + m;
  return !/Sat|Sun/.test(day) && t >= 9 * 60 + 32 && t < 16 * 60;
};

// Proof of life for the background schedule: when each job last ran and what
// it is waiting on. Red when the every-minute exit check has gone quiet.
function AutomationStatus({ activity }) {
  const a = activity || {};
  const stale = marketHoursNow() && minutesAgo(a.exits?.at) > 3;
  const watching = a.entries?.watching || [];
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
      {stale && <div className="err" style={{ marginBottom: 8 }}>The automatic exit check has not run for {Number.isFinite(minutesAgo(a.exits?.at)) ? Math.round(minutesAgo(a.exits?.at)) + " minutes" : "a while"}. Open positions are not being watched.</div>}
      <div className="mono muted">
        Automation · exits checked {clockTime(a.exits?.at)}{a.exits ? ` (${a.exits.checked} open, ${a.exits.closed} sold)` : ""}
        {" · "}entries checked {clockTime(a.entries?.at)}{a.entries ? ` (${a.entries.placed} bought)` : ""}
        {" · "}ideas refreshed {clockTime(a.refresh?.at)}{a.refresh ? ` (${a.refresh.ideas} ideas, ${a.refresh.setups?.length ?? 0} setup${a.refresh.setups?.length === 1 ? "" : "s"})` : ""}
      </div>
      {watching.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <span className="muted">Waiting on: </span>
          {watching.map((w, i) => (
            <span key={w.symbol + i} style={{ marginRight: 14 }}>
              <b>{w.symbol}</b> {String(w.action || "").toLowerCase()}{w.intraday ? " (same-day)" : ""} <span className="muted">— {w.note.replace(/^Not triggered — /, "")}</span>
            </span>
          ))}
        </div>
      )}
      {a.entries && !watching.length && <div className="muted" style={{ marginTop: 6 }}>No setup is waiting on a price right now — every current idea says wait.</div>}
    </div>
  );
}

// The kill switch and the daily loss limit (app/api/riskLib.js), on the
// account card. Both stop NEW entries only; exits keep running. A manual stop
// lasts until resumed here. A daily-loss stop clears itself at the next
// session and cannot be resumed early: resuming would only re-trip on the
// next entry check, since today's loss is still past the line.
// Announces every change on window as "cockpit:halt" so the header badge
// (page.js) follows without waiting for its own poll.
export const HALT_EVENT = "cockpit:halt";
const HALT_TITLES = {
  daily_loss: "Daily loss limit reached",
  loss_streak: "Losing streak",
  profit_lock: "Daily goal banked",
  day_giveback: "Giving back the day",
};

function TradingSwitch({ halt, onChange }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const send = async (body) => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/halt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      onChange(d);
      setAsking(false); setReason("");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const resume = () => {
    if (!window.confirm("Resume new trades? The automation will start buying again on the next entry check.")) return;
    send({ halted: false });
  };

  if (!halt) return null;
  const loss = Math.max(0, -(Number(halt.lossToday) || 0));
  const limit = Number(halt.limitUsd) || 0;
  const used = limit > 0 ? Math.min(1, loss / limit) : 0;
  const barColor = used >= 1 ? "var(--bear)" : used >= 0.6 ? "#A37820" : "var(--bull)";
  const since = halt.since ? new Date(halt.since).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
      {halt.halted && (
        <div className="danger" style={{ marginBottom: 10 }}>
          <b>New trades are stopped</b>{since ? <span style={{ fontWeight: 400 }}> · since {since}</span> : null}
          <div className="d2">
            {halt.kind === "manual"
              ? <>Stopped by hand{halt.reason && halt.reason !== "halted by hand" ? <> — “{halt.reason}”</> : null}. Stays stopped until you resume it.</>
              : <>{HALT_TITLES[halt.kind] || "Stopped by a daily rule"}: {halt.reason}</>}
            {" "}Open positions are still managed — stops, targets and the trail keep running.
          </div>
          {halt.kind === "manual" && (
            <button className="btn" style={{ marginTop: 10, background: "#F7F5EF", color: "var(--bear)" }} disabled={busy} onClick={resume}>
              {busy ? "Resuming…" : "Resume new trades"}
            </button>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12.5 }}>
        <span className="mono" style={{ minWidth: 0 }}>
          <span className="muted">Today's realized loss </span>
          <b style={{ color: loss > 0 ? "var(--bear)" : "inherit" }}>{usd0(loss)}</b>
          <span className="muted"> of {usd0(limit)} daily limit ({halt.limitPct}%)</span>
        </span>
        <span aria-hidden="true" style={{ flex: "1 1 120px", minWidth: 80, height: 6, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 3, overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: `${(used * 100).toFixed(1)}%`, background: barColor }} />
        </span>
        {!halt.halted && !asking && (
          <button className="chip" style={{ color: "var(--bear)", borderColor: "rgba(154,71,54,.5)" }} onClick={() => setAsking(true)}>Stop new trades</button>
        )}
      </div>

      {halt.day && halt.limits && (
        <div className="mono muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
          Day plan · goal {usd0(halt.limits.goalUsd)} · take the day at {usd0(halt.limits.profitLockUsd)} · {halt.limits.maxStreak} losses in a row stops · give back {halt.limits.givebackPct}% of the day's peak stops
          {" · "}today: {halt.day.closes} closed ({halt.day.wins} won, {halt.day.losses} lost)
          {halt.day.peak > 0 ? <>, peaked at <b>{usd0(halt.day.peak)}</b></> : null}
          {halt.day.streak > 0 ? <>, <b style={{ color: "var(--bear)" }}>{halt.day.streak} loss{halt.day.streak === 1 ? "" : "es"} in a row</b></> : null}
        </div>
      )}

      {!halt.halted && asking && (
        <form style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}
          onSubmit={(e) => { e.preventDefault(); send({ halted: true, reason }); }}>
          <input className="in" style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13 }} autoFocus maxLength={200}
            placeholder="Why? (optional — e.g. FOMC today)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn" style={{ background: "var(--bear)" }} disabled={busy} type="submit">{busy ? "Stopping…" : "Stop new trades"}</button>
          <button className="chip" type="button" disabled={busy} onClick={() => { setAsking(false); setReason(""); }}>Cancel</button>
          <div className="muted" style={{ flexBasis: "100%", fontSize: 12 }}>The automation stops opening positions. Anything already open is still sold on its stop, target or trail.</div>
        </form>
      )}
      {err && <div className="err" style={{ marginTop: 10, marginBottom: 0 }}>{err}</div>}
    </div>
  );
}

// What the realized record says about each way of trading — see
// app/api/edgeLib.js. The number that matters is expectancy in R: the
// average trade, in units of the most one trade may lose. Groups under the
// minimum sample show their count and no verdict.
function EdgePanel() {
  const [edge, setEdge] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setEdge(await getJSON("/api/edge")); setErr(""); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS * 4); return () => clearInterval(t); }, [load]);

  const o = edge?.overall;
  const r = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "R");
  const pf = (v) => (v == null ? "—" : v === Infinity || v === null ? "∞" : v.toFixed(2));
  const tone = (v) => ({ color: v == null || v === 0 ? "inherit" : v > 0 ? "var(--bull)" : "var(--bear)" });
  const Table = ({ title, rows, keyLabel }) => rows?.length ? (
    <div style={{ marginTop: 12 }}>
      <span className="label">{title}</span>
      <table>
        <thead><tr><th style={{ textAlign: "left" }}>{keyLabel}</th><th>n</th><th>win</th><th>avg win</th><th>avg loss</th><th>PF</th><th>expectancy</th><th>net</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} style={{ opacity: g.enough ? 1 : 0.55 }}>
              <td style={{ textAlign: "left" }}>{g.key}{!g.enough ? <span className="muted"> (too few)</span> : null}</td>
              <td>{g.n}</td><td>{pctFmt(g.winRate)}</td><td>{usd0(g.avgWin)}</td><td>{usd0(g.avgLoss)}</td><td>{pf(g.profitFactor)}</td>
              <td style={tone(g.expectancyR)}>{r(g.expectancyR)}</td><td style={tone(g.netUsd)}>{usd0(g.netUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Edge · what the closed trades actually paid{edge?.since ? ` · since ${new Date(edge.since).toLocaleDateString()}` : ""}</span>
        <button className="chip" onClick={() => setOpen((v) => !v)}>{open ? "Less" : "By playbook, hour, exit…"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {o && o.n === 0 && <div className="muted" style={{ fontSize: 13 }}>No closed trades yet since the fresh start.</div>}
      {o && o.n > 0 && (
        <>
          <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
            <div className="metric"><div className="k">Closed trades</div><div className="v">{o.n}</div></div>
            <div className="metric"><div className="k">Expectancy</div><div className="v" style={tone(o.expectancyR)}>{r(o.expectancyR)}</div></div>
            <div className="metric"><div className="k">Profit factor</div><div className="v" style={tone(o.profitFactor == null ? null : o.profitFactor - 1)}>{pf(o.profitFactor)}</div></div>
            <div className="metric"><div className="k">Win rate</div><div className="v">{pctFmt(o.winRate)}</div></div>
            <div className="metric"><div className="k">Avg win / loss</div><div className="v" style={{ fontSize: 16 }}>{usd0(o.avgWin)} / {usd0(o.avgLoss)}</div></div>
            <div className="metric"><div className="k">Max drawdown</div><div className="v" style={{ color: "var(--bear)" }}>{usd0(-o.maxDrawdownUsd)}</div></div>
          </div>
          <div className="mono muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            1R = {usd0(edge.rUsd)}, the most one trade may lose. Last {edge.lastN}: {r(edge.recent?.expectancyR)} per trade, PF {pf(edge.recent?.profitFactor)}.
            {" "}Edge gate {edge.edgeGate ? "on" : "off"}:
            {" "}{Object.entries(edge.verdicts || {}).filter(([k]) => k !== "manual").map(([k, v]) => (
              <span key={k} style={{ marginLeft: 8, color: v.ok ? "inherit" : "var(--bear)" }}><b>{k}</b> {v.ok ? "trading" : "STOPPED"} ({v.reason})</span>
            ))}
          </div>
          {open && (
            <>
              <Table title="By playbook" keyLabel="playbook" rows={edge.byPlaybook} />
              <Table title="By entry hour (ET)" keyLabel="hour" rows={edge.byHour} />
              <Table title="By exit reason" keyLabel="exit" rows={edge.byExitTag} />
              <Table title="By symbol" keyLabel="symbol" rows={edge.bySymbol?.slice(0, 12)} />
              <Table title="By catalyst" keyLabel="catalyst" rows={edge.byCatalyst?.slice(0, 12)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// The account in one row: what the practice account has made since the
// fresh start, what is open right now, and how much cash can still buy today.
function AccountSummary() {
  const [acct, setAcct] = useState(null);
  const [openPnl, setOpenPnl] = useState(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState(null);
  const [halt, setHalt] = useState(null);

  const onHalt = useCallback((h) => {
    setHalt(h);
    try { window.dispatchEvent(new CustomEvent(HALT_EVENT, { detail: h })); } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      getJSON("/api/halt").then(onHalt).catch(() => {});
      const [a, p] = await Promise.all([getJSON("/api/account"), getJSON("/api/positions")]);
      setAcct(a);
      const list = p.positions || [];
      setOpenPnl(list.length ? list.reduce((s, x) => s + (Number(x.unrealizedPnl) || 0), 0) : 0);
      setAt(new Date()); setErr("");
    } catch (e) { setErr(e.message); }
  }, [onHalt]);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const L = acct?.ledger;
  const tone = (v) => ({ color: v == null || v === 0 ? "inherit" : v > 0 ? "var(--bull)" : "var(--bear)" });
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>
          Practice account · {acct ? usd0(acct.startCash) : "…"} simulated cash, real-time prices
          {L?.since ? ` · since ${new Date(L.since).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
        </span>
        <span className="muted mono" style={{ fontSize: 11 }}>{at ? `updated ${at.toLocaleTimeString()}` : ""}</span>
      </div>
      {err && <div className="err">{err}</div>}
      {acct && (
        <>
          <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            <div className="metric"><div className="k">Realized profit</div><div className="v" style={tone(L.realized)}>{usd0(L.realized)}</div></div>
            <div className="metric"><div className="k">Open positions now</div><div className="v" style={tone(openPnl)}>{usd0(openPnl)}</div></div>
            <div className="metric"><div className="k">Cash to buy today</div><div className="v">{usd0(acct.available)}</div></div>
            <div className="metric"><div className="k">Settles tomorrow</div><div className="v">{usd0(acct.unsettled)}</div></div>
          </div>
        </>
      )}
      {/* Outside the account block on purpose: the switch has to work when the
          broker is unreachable, which is exactly when it may be needed. */}
      <TradingSwitch halt={halt} onChange={onHalt} />
      {acct && (
        <>
          <AutomationStatus activity={acct.activity} />
          <div className="mono muted" style={{ fontSize: 12, marginTop: 8, textAlign: "center" }}>
            {L.closes} closed trade{L.closes === 1 ? "" : "s"} ({L.wins} won, {L.losses} lost) · {L.open} open · fees paid {usd(acct.feesPaid)} · realized profit is after fees; open positions are valued at what they would sell for now
          </div>
        </>
      )}
    </div>
  );
}

function PositionsPanel() {
  const [positions, setPositions] = useState(null);
  const [err, setErr] = useState("");
  const [openSym, setOpenSym] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setPositions((await getJSON("/api/positions")).positions || []); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Keep the prices live, but not while a close form is open under the table.
  useEffect(() => {
    if (openSym) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, openSym]);

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Open positions · paper account, valued at the real-time bid</span>
        <button className="chip" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {positions && !positions.length && <div className="muted" style={{ fontSize: 13 }}>No open positions.</div>}
      {positions && positions.length > 0 && (
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Symbol</th><th>Qty</th><th>Cost basis</th><th>Sell price now</th><th>Gain / loss</th><th style={{ textAlign: "left" }}>Sells automatically at</th><th></th>
          </tr></thead>
          <tbody>
            {/* Soonest expiry first (2026-10-15, the owner): what expires today is on
                top. Shares, which never expire, go last; ties by symbol. */}
            {[...positions].sort((a, b) => String(a.expiration || "9999").localeCompare(String(b.expiration || "9999")) || String(a.underlying).localeCompare(String(b.underlying))).map((p) => {
              const isOpen = openSym === p.symbol;
              return (
                <Fragment key={p.symbol}>
                  <tr>
                    <td style={{ textAlign: "left" }}>
                      <span style={{ fontWeight: 600 }}>{p.underlying}</span>
                      {p.vehicle === "OPTION" && <span className="muted"> {p.strike} {p.optionType} {p.expiration}</span>}
                    </td>
                    <td>{p.quantity}</td>
                    <td className="muted">{usd(p.costBasis)}</td>
                    <td>{p.last != null ? "$" + Number(p.last).toFixed(2) : "—"}</td>
                    <td className={p.unrealizedPnl == null ? "muted" : p.unrealizedPnl >= 0 ? "up" : "down"} style={{ fontWeight: 600 }}>
                      {usd(p.unrealizedPnl)}
                      {p.unrealizedPnl != null && p.costBasis > 0 && (
                        <span style={{ fontWeight: 400, marginLeft: 6 }}>({p.unrealizedPnl >= 0 ? "+" : "−"}{Math.abs((p.unrealizedPnl / p.costBasis) * 100).toFixed(1)}%)</span>
                      )}
                    </td>
                    <td style={{ textAlign: "left" }}><ExitPlanCell plan={p.journal?.exitPlan} symbol={p.underlying} /></td>
                    <td><button className="chip" onClick={() => setOpenSym(isOpen ? null : p.symbol)}>{isOpen ? "hide" : "close…"}</button></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "left", background: "var(--paper)", padding: "10px" }}>
                        {p.journal && (
                          <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                            {p.journal.thesis && <>Plan: {p.journal.thesis} </>}
                            {p.journal.invalidation != null && p.journal.target != null && (
                              <>· stop {usd(p.journal.invalidation)} → target {usd(p.journal.target)}</>
                            )}
                          </div>
                        )}
                        <ClosePositionControl position={p} onClosed={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const STRATEGY_TAG = { ai: "AI idea", intraday: "same-day", sweep_limit: "sweep · limit", sweep_reclaim: "sweep · reclaim" };
const GRADE_TONE = (v) => v == null ? "muted" : v >= 0 ? "up" : "down";

function AutoJournalPanel() {
  const [all, setAll] = useState(null);
  const [since, setSince] = useState(null);
  const [showOld, setShowOld] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await getJSON("/api/journal"); setAll(d.entries || []); setSince(d.freshStartAt || null); }
    catch { setAll([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS * 2);
    return () => clearInterval(t);
  }, [load]);
  // Trades from before the fresh start were filled by the old sandbox on
  // delayed prices; they are history, not this account's record.
  const isOld = (e) => e.legacy === true || (since && new Date(e.createdAt) < new Date(since));
  const older = all ? all.filter(isOld).length : 0;
  /* Newest EVENT first: a close lands at the top on the day it happens. Sorted
     by open date, a position bought yesterday and sold today (GOOGL shares,
     -$17.76, 2026-10-14) sat below all of today's trades under yesterday. */
  const lastEvent = (e) => new Date(e.exitAt || e.entryAt || e.createdAt).getTime();
  const entries = all ? (showOld ? all : all.filter((e) => !isOld(e))).slice().sort((a, b) => lastEvent(b) - lastEvent(a)) : null;
  const when = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Trade journal · {showOld ? "all trades, including the old sandbox ones" : "this practice account"}</span>
        <span style={{ display: "flex", gap: 6 }}>
          {older > 0 && <button className="chip" onClick={() => setShowOld((v) => !v)}>{showOld ? "Hide" : "Show"} {older} older</button>}
          <button className="chip" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        </span>
      </div>
      {entries && !entries.length && <div className="muted" style={{ fontSize: 13 }}>No trades on this practice account yet — each buy and sell is logged here automatically.</div>}
      {entries && entries.length > 0 && (
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Opened</th><th style={{ textAlign: "left" }}>Closed</th><th style={{ textAlign: "left" }}>Symbol</th>
            <th style={{ textAlign: "left" }}>Plan</th><th style={{ textAlign: "left" }}>Sells for profit at</th><th>Status</th>
            <th style={{ textAlign: "left" }}>Exit reason</th><th>P&amp;L</th><th>R</th><th>Days</th>
          </tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} style={isOld(e) ? { opacity: 0.55 } : undefined}>
                <td style={{ textAlign: "left" }} className="muted">{when(e.entryAt || e.createdAt)}</td>
                <td style={{ textAlign: "left" }} className="muted">{e.status === "open" ? "open" : when(e.exitAt)}</td>
                <td style={{ textAlign: "left", fontWeight: 600 }}>{e.symbol}</td>
                <td style={{ textAlign: "left" }} title={e.thesis || ""}>
                  {e.vehicle === "OPTION" ? `${e.optionType ?? ""} ${e.strike ?? ""} ${e.expiration ?? ""}` : "shares"}
                  {e.source === "idea" && <span className="badge" style={{ fontSize: 10, marginLeft: 6, padding: "1px 5px" }}>{STRATEGY_TAG[e.strategy || "ai"] || "from idea"}</span>}
                </td>
                <td style={{ textAlign: "left" }}>{e.status === "unfilled" ? <span className="muted">—</span> : <ExitPlanCell plan={e.exitPlan} symbol={e.symbol} faded={e.status !== "open"} />}</td>
                <td className={e.status === "open" ? "" : "muted"} title={e.status === "unfilled" ? "The entry limit expired without filling — logged so fill rate is measurable" : ""}>{e.status}</td>
                <td style={{ textAlign: "left", fontSize: 12.5 }} className="muted">{e.exitReason || "—"}</td>
                <td className={GRADE_TONE(e.pnl)} style={{ fontWeight: 600 }}>{e.pnl != null ? usd(e.pnl) : "—"}</td>
                <td className={GRADE_TONE(e.rMultiple)}>{e.rMultiple != null ? (e.rMultiple >= 0 ? "+" : "") + e.rMultiple.toFixed(2) : "—"}</td>
                <td className="muted">{e.daysHeld != null ? e.daysHeld.toFixed(1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Journal() {
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState(blank());
  const hydrated = useRef(false);
  const fileRef = useRef(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_journal"));
      if (Array.isArray(saved)) setEntries(saved);
    } catch {}
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("cockpit_journal", JSON.stringify(entries)); } catch {}
  }, [entries]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setSymbol = (e) => {
    const symbol = e.target.value.toUpperCase();
    setForm((f) => {
      const iv = f.entryIv === "" || f.autoIv ? latestIv(symbol) : null;
      return iv != null ? { ...f, symbol, entryIv: (iv * 100).toFixed(1), autoIv: true } : { ...f, symbol };
    });
  };
  const addEntry = () => {
    if (!form.symbol.trim() || !form.structure.trim()) return;
    const { autoIv, ...rest } = form;
    setEntries((es) => [{ ...rest, symbol: form.symbol.trim(), id: Date.now() + "-" + Math.random().toString(36).slice(2, 7) }, ...es]);
    setForm(blank());
  };
  const update = (id, patch) => setEntries((es) => es.map((e) => e.id === id ? { ...e, ...patch } : e));
  const remove = (id) => setEntries((es) => es.filter((e) => e.id !== id));

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cockpit-journal-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJSON = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error("not an array");
      const incoming = parsed.filter((x) => x && x.symbol).map((x) => ({ ...x, id: x.id || Date.now() + "-" + Math.random().toString(36).slice(2, 7) }));
      setEntries((es) => {
        const byId = new Map(es.map((x) => [x.id, x]));
        incoming.forEach((x) => byId.set(x.id, x));
        return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
      });
    } catch { alert("Import failed — expected a JSON array exported from this journal."); }
  };

  const s = journalStats(entries);

  return (
    <>
      <AccountSummary />
      <EdgePanel />
      <PositionsPanel />
      <AutoJournalPanel />

      <div className="card">
        <span className="label">Log a manual trade &middot; for anything placed outside this app</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="in" type="date" value={form.date} onChange={set("date")} />
          <input className="in" style={{ width: 90 }} placeholder="SYMBOL" value={form.symbol} onChange={setSymbol} />
          <input className="in" style={{ width: 200 }} placeholder="Structure (e.g. 550/560 call spread)" value={form.structure} onChange={set("structure")} />
          <select className="sel" value={form.direction} onChange={set("direction")}>
            <option value="bull">bull</option><option value="bear">bear</option><option value="neutral">neutral</option>
          </select>
          <select className="sel" value={form.premium} onChange={set("premium")}>
            <option value="bought">premium bought</option><option value="sold">premium sold</option>
          </select>
          <input className="in" style={{ width: 110 }} placeholder="Entry IV %" inputMode="decimal" value={form.entryIv}
            onChange={(e) => setForm((f) => ({ ...f, entryIv: e.target.value.replace(/[^0-9.]/g, ""), autoIv: false }))} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <input className="in" style={{ flex: 1, minWidth: 240 }} placeholder="Thesis — why this trade?" value={form.thesis} onChange={set("thesis")}
            onKeyDown={(e) => e.key === "Enter" && addEntry()} />
          <button className="btn" onClick={addEntry}>Log trade</button>
        </div>
      </div>

      <div className="card">
        <span className="label">Stats · manual entries below only</span>
        {s.nClosed < 10 ? (
          <div className="muted" style={{ fontSize: 13 }}>insufficient data (&lt;10 closed trades — {s.nClosed} so far)</div>
        ) : (
          <>
            <div className="metrics">
              <div className="metric"><div className="k">Win rate</div><div className="v">{pctFmt(s.winRate)}</div></div>
              <div className="metric"><div className="k">Expectancy / trade</div><div className="v" style={{ color: s.expectancy >= 0 ? "var(--bull)" : "var(--bear)" }}>{usd(s.expectancy)}</div></div>
              <div className="metric"><div className="k">Avg win / avg loss</div><div className="v">{usd(s.avgWin)} / {usd(s.avgLoss)}</div></div>
            </div>
            <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>
              by premium — bought: {pctFmt(s.byPremium.bought)} · sold: {pctFmt(s.byPremium.sold)}
              {" · "}by direction — bull: {pctFmt(s.byDirection.bull)} · bear: {pctFmt(s.byDirection.bear)} · neutral: {pctFmt(s.byDirection.neutral)}
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span className="label" style={{ margin: 0 }}>Manual entries · {entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="chip" onClick={exportJSON} disabled={!entries.length}>export JSON</button>
            <button className="chip" onClick={() => fileRef.current?.click()}>import JSON</button>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={importJSON} />
          </div>
        </div>
        {!entries.length && <div className="muted" style={{ fontSize: 13 }}>No trades logged yet.</div>}
        {entries.length > 0 && (
          <table>
            <thead><tr>
              <th style={{ textAlign: "left" }}>Date</th><th style={{ textAlign: "left" }}>Symbol</th>
              <th style={{ textAlign: "left" }}>Structure</th><th>Dir</th><th>Premium</th><th>Entry IV</th>
              <th>Status</th><th>P&amp;L $</th><th></th>
            </tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ textAlign: "left" }}>{e.date}</td>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{e.symbol}</td>
                  <td style={{ textAlign: "left" }} title={e.thesis}>{e.structure}{e.thesis ? " *" : ""}</td>
                  <td>{e.direction}</td><td>{e.premium}</td>
                  <td className="muted">{e.entryIv ? e.entryIv + "%" : "—"}</td>
                  <td>
                    <select className="sel" style={{ padding: "3px 6px", fontSize: 12 }} value={e.status} onChange={(ev) => update(e.id, { status: ev.target.value })}>
                      <option value="open">open</option><option value="won">won</option>
                      <option value="lost">lost</option><option value="scratched">scratched</option>
                    </select>
                  </td>
                  <td>
                    <input className="in" style={{ width: 80, padding: "3px 6px", fontSize: 12, textAlign: "right" }} inputMode="decimal"
                      value={e.pnl ?? ""} placeholder="0"
                      onChange={(ev) => update(e.id, { pnl: ev.target.value.replace(/[^0-9.\-]/g, "") })} />
                  </td>
                  <td><button className="x" onClick={() => remove(e.id)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {entries.some((e) => e.thesis) && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>* hover a structure to read the thesis</div>}
      </div>
    </>
  );
}
