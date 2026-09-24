"use client";
import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { DEFAULT_SWEEP_SYMS as SWEEP_DEFAULTS } from "../lib/sweep";

/* Sweeps tab: the liquidity-sweep (stop-hunt) detector, both variants side
   by side, each symbol's own backtest, the paper autopilot for it, and the
   AI-vs-sweeps comparison. See app/lib/sweep.js for the detector itself. */

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const f2 = (v) => v == null ? "—" : Number(v).toFixed(2);
const usd = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const pct = (v) => v == null ? "—" : (v * 100).toFixed(0) + "%";
const rTxt = (v) => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
const tone = (v) => v == null ? "muted" : v >= 0 ? "up" : "down";

export const readSweepSyms = () => {
  try {
    const v = JSON.parse(localStorage.getItem("sweep_syms"));
    if (Array.isArray(v) && v.length) return v;
  } catch {}
  return SWEEP_DEFAULTS;
};
const readAccount = () => {
  try { const v = Number(localStorage.getItem("cockpit_account")); if (v > 0) return v; } catch {}
  return 1000;
};

const AUTOPILOT_MS = 5 * 60 * 1000;

/* Paper autopilot for sweeps. Lives at the Page level (not inside the tab)
   so it keeps running while you're on another tab — but like the Ideas
   schedule, only while this app is open in a browser somewhere. Calls
   /api/sweeps/autotrade every 5 min during regular hours; the route itself
   also refuses to place anything outside them. */
export function useSweepAutopilot(clockState) {
  const [on, setOnState] = useState(false);
  const [last, setLast] = useState(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    try { setOnState(localStorage.getItem("sweep_autopilot") === "on"); } catch {}
  }, []);
  const setOn = (v) => {
    setOnState(v);
    try { localStorage.setItem("sweep_autopilot", v ? "on" : "off"); } catch {}
  };
  const runNow = useCallback(async ({ dryRun = false } = {}) => {
    setRunning(true);
    try {
      const d = await getJSON(`/api/sweeps/autotrade?symbols=${readSweepSyms().join(",")}&account=${readAccount()}${dryRun ? "&dryRun=true" : ""}`);
      setLast({ at: Date.now(), ...d });
    } catch (e) {
      setLast({ at: Date.now(), error: e.message });
    } finally {
      setRunning(false);
    }
  }, []);
  const isOpen = clockState === "open" || clockState === "unknown";
  useEffect(() => {
    if (!on || !isOpen) return;
    runNow();
    const t = setInterval(runNow, AUTOPILOT_MS);
    return () => clearInterval(t);
  }, [on, isOpen, runNow]);
  return { on, setOn, last, running, runNow, isOpen };
}

function SetupCard({ s }) {
  const limit = s.strategy === "sweep_limit";
  const status = limit && s.id
    ? s.filled ? "limit reached today" : s.pendingFill ? "resting — not reached yet" : null
    : null;
  return (
    <div style={{ padding: "10px 12px", marginTop: 8, border: "1px solid var(--line)", borderRadius: 3, background: "var(--paper)", opacity: s.setup?.ok ? 1 : 0.6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 12.5 }}>
        <span style={{ fontWeight: 700 }}>
          {s.symbol} · {limit ? "LIMIT at the stops" : `RECLAIM (${s.setup?.timeframe})`}
          {status && <span className="badge" style={{ marginLeft: 8, fontSize: 10, padding: "1px 5px" }}>{status}</span>}
          {!s.setup?.ok && <span className="badge" style={{ marginLeft: 8, fontSize: 10, padding: "1px 5px" }} title="Shown for context, not logged or traded">filtered: trend {s.setup?.trend}</span>}
        </span>
        <span className="muted">conviction {s.conviction}/5{s.id ? " · logged" : ""}</span>
      </div>
      <div className="mono" style={{ fontSize: 12.5, marginTop: 4 }}>
        buy {usd(s.entryPrice)} · stop <span className="down">{usd(s.invalidation)}</span> · target <span className="up">{usd(s.target)}</span>
        {s.setup?.rr != null && <span className="muted"> · R:R {s.setup.rr.toFixed(1)}</span>}
        {s.sizing?.note && <span className="muted"> · {s.sizing.note}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{s.setup?.why}</div>
    </div>
  );
}

function Comparison() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getJSON("/api/sweeps/compare?days=60").then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const G = ({ g }) => g?.n ? (
    <span className={g.winRate >= 0.5 ? "up" : "down"} title={g.n < 5 ? "fewer than 5 — don't read much into it" : ""}>
      {pct(g.winRate)} <span className="muted">n={g.n}{g.n < 5 ? "*" : ""}{g.avgR != null ? ` · ${rTxt(g.avgR)}` : ""}</span>
    </span>
  ) : <span className="muted">—</span>;
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>AI ideas vs sweeps · last 60 days, same ledger, same journal</span>
        <button className="chip" onClick={load}>Refresh</button>
      </div>
      {err && <div className="err">{err}</div>}
      {data && (
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Strategy</th><th>Suggested</th><th>Limit reached</th>
            <th>+1h</th><th>+1d</th><th>Final</th>
            <th>Paper trades</th><th>Closed / stopped</th><th>Trade win</th><th>Trade avg R</th><th>P&amp;L</th>
          </tr></thead>
          <tbody>
            {data.strategies.map((s) => (
              <tr key={s.key}>
                <td style={{ textAlign: "left", fontWeight: 600 }}>{s.label}</td>
                <td>{s.ledger.suggested}</td>
                <td className="muted">{s.ledger.filled != null ? `${s.ledger.filled} / ${s.ledger.filled + s.ledger.unfilled}` : "n/a"}</td>
                <td><G g={s.ledger.h1} /></td><td><G g={s.ledger.d1} /></td><td><G g={s.ledger.final} /></td>
                <td>{s.journal.placed}{s.journal.unfilled ? <span className="muted"> ({s.journal.unfilled} unfilled)</span> : ""}</td>
                <td className="muted">{s.journal.closed} / {s.journal.stoppedOut}</td>
                <td className={s.journal.winRate == null ? "muted" : s.journal.winRate >= 0.5 ? "up" : "down"}>{pct(s.journal.winRate)}</td>
                <td className={tone(s.journal.avgR)}>{rTxt(s.journal.avgR)}</td>
                <td className={tone(s.journal.totalPnl)} style={{ fontWeight: 600 }}>{usd(s.journal.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
        Left half grades every suggestion at +1h / +1d / final (5 days for shares), the same way the Track Record does. A resting limit only counts once
        price actually reached it; "limit reached" is its fill rate. Right half is real paper orders from both autopilots: fills, bracket-stop exits and
        expired limits are read back from Tradier automatically. * = fewer than 5, noise.
      </div>
    </div>
  );
}

export default function Sweeps({ autopilot }) {
  const [syms, setSyms] = useState(SWEEP_DEFAULTS);
  const [draft, setDraft] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [openSym, setOpenSym] = useState(null);
  const hydrated = useRef(false);

  useEffect(() => { setSyms(readSweepSyms()); hydrated.current = true; }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("sweep_syms", JSON.stringify(syms)); } catch {}
  }, [syms]);

  const scan = useCallback(async (list) => {
    setLoading(true); setErr("");
    try { setData(await getJSON(`/api/sweeps?symbols=${list.join(",")}&account=${readAccount()}`)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (hydrated.current) scan(syms); }, [syms, scan]);
  useEffect(() => { if (autopilot.last && !autopilot.last.error) scan(syms); }, [autopilot.last]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    const s = draft.trim().toUpperCase();
    if (s && !syms.includes(s)) setSyms([...syms, s]);
    setDraft("");
  };
  const rows = (data?.symbols || []).slice().sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  const liveSetups = rows.flatMap((r) => r.setups || []);
  const last = autopilot.last;

  return (
    <>
      <div className="card">
        <span className="label">Liquidity sweeps · buying where the stops are, two ways</span>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          A <b>level</b> is an unswept daily swing low, where stop-losses cluster just underneath.
          {" "}<b>LIMIT</b> is the naive version: a resting buy just under the level, stop 1 ATR below it. It fills on every real breakdown and only
          sometimes on the quick wick. <b>RECLAIM</b> waits for price to trade under the level and close back above it, then buys with the stop under the sweep low.
          Both are logged to the same ledger as AI ideas and graded the same way.
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          {syms.map((s) => (
            <span key={s} className="chip" style={{ padding: "3px 8px" }}>
              {s} <button className="x" style={{ fontSize: 13, padding: 0, marginLeft: 2 }} onClick={() => setSyms(syms.filter((x) => x !== s))}>×</button>
            </span>
          ))}
          <input className="in" style={{ width: 90, padding: "5px 8px" }} placeholder="ADD" value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="chip" onClick={() => setSyms(SWEEP_DEFAULTS)}>reset</button>
          <button className="btn" onClick={() => scan(syms)} disabled={loading}>{loading ? "Scanning…" : "Scan now"}</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span className="label" style={{ margin: 0 }}>Sweep autopilot · paper only, same order path as the AI autotrade</span>
          <span style={{ display: "flex", gap: 6 }}>
            <button className="chip" onClick={() => autopilot.runNow({ dryRun: true })} disabled={autopilot.running}>dry run</button>
            <button className="chip" onClick={() => autopilot.runNow()} disabled={autopilot.running}>{autopilot.running ? "running…" : "run once"}</button>
            <button className={autopilot.on ? "btn" : "chip"} onClick={() => autopilot.setOn(!autopilot.on)}>
              {autopilot.on ? "● auto: ON" : "auto: off"}
            </button>
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {autopilot.on
            ? autopilot.isOpen ? "Checks every 5 min while this app is open in a browser." : "On. Waiting for the regular session to open."
            : "Off. Scans still log suggestions to the ledger, but nothing gets bought."}
          {" "}One open position per symbol across both strategies. Every order is a limit with a bracket stop, sized 1% risk / 25% cap like Ideas.
        </div>
        {last && (
          <div style={{ marginTop: 10 }}>
            {last.error && <div className="err">{last.error}</div>}
            {!last.error && (
              <div className="mono" style={{ fontSize: 12 }}>
                {new Date(last.at).toLocaleTimeString()} · {last.dryRun ? "DRY RUN · " : ""}{last.note || `placed ${last.placed}, skipped ${last.skipped}`}
                {(last.results || []).map((r, i) => (
                  <div key={i} className={r.placed ? "up" : "muted"} style={{ marginTop: 2 }}>
                    {r.placed ? "✓" : r.dryRun ? "◦" : "–"} {r.symbol} {r.strategy?.replace("sweep_", "")} @ {usd(r.entry)}
                    {r.placed ? ` · order #${r.order?.id ?? "?"}${r.stopAttached ? `, stop ${usd(r.stopPrice)}` : ""}` : r.dryRun ? " · would place" : ` · ${r.reason}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <span className="label">Live setups · {liveSetups.length} right now{data?.asOf ? ` · as of ${new Date(data.asOf).toLocaleTimeString()}` : ""}</span>
        {err && <div className="err">{err}</div>}
        {!liveSetups.length && !loading && (
          <div className="muted" style={{ fontSize: 13 }}>
            Nothing on this list is near an unswept low or reclaiming one right now. That's normal: in the backtest these came up roughly 4–7 times per 100 trading days per symbol.
          </div>
        )}
        {liveSetups.map((s, i) => <SetupCard key={s.setupKey + i} s={s} />)}
      </div>

      <Comparison />

      <div className="card" style={{ overflowX: "auto" }}>
        <span className="label">Which names suit this · each symbol's own ~2-year daily backtest, best fit first</span>
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Symbol</th><th>Price</th><th>Trend</th><th>Nearest level</th>
            <th>Sweeps /100d</th><th>Reclaimed</th>
            <th>Limit n · win · avg</th><th>Limit fill</th><th>Reclaim n · win · avg</th><th>Fit</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => r.error ? (
              <tr key={r.symbol}><td style={{ textAlign: "left", fontWeight: 600 }}>{r.symbol}</td><td colSpan={9} className="muted" style={{ textAlign: "left" }}>{r.error}</td></tr>
            ) : (
              <Fragment key={r.symbol}>
                <tr className="row-btn" onClick={() => setOpenSym(openSym === r.symbol ? null : r.symbol)}>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{openSym === r.symbol ? "▾" : "▸"} {r.symbol}</td>
                  <td>{usd(r.price)}</td>
                  <td className={r.trend === "uptrend" ? "up" : r.trend === "downtrend" ? "down" : "muted"}>{r.trend}</td>
                  <td>{r.nearestLevel ? <>{usd(r.nearestLevel.price)} <span className="muted">({r.nearestLevel.distanceAtr.toFixed(1)} ATR)</span></> : "—"}</td>
                  <td>{f2(r.backtest.sweepsPer100)}</td>
                  <td>{pct(r.backtest.reclaimRate)}</td>
                  <td className={tone(r.backtest.limit.avgR)}>{r.backtest.limit.n} · {pct(r.backtest.limit.winRate)} · {rTxt(r.backtest.limit.avgR)}</td>
                  <td className="muted">{pct(r.backtest.limit.fillRate)}</td>
                  <td className={tone(r.backtest.reclaim.avgR)}>{r.backtest.reclaim.n} · {pct(r.backtest.reclaim.winRate)} · {rTxt(r.backtest.reclaim.avgR)}</td>
                  <td style={{ fontWeight: 700 }}>{r.fit ?? "—"}</td>
                </tr>
                {openSym === r.symbol && (
                  <tr>
                    <td colSpan={10} style={{ textAlign: "left", background: "var(--paper)", fontSize: 12 }}>
                      <div>Unswept levels below price: {r.levels.map((l) => `${usd(l.price)} (${l.date}${l.touches ? `, ${l.touches + 1} equal lows` : ""})`).join(" · ") || "none in the last 60 bars"} · ATR {usd(r.atr)}</div>
                      {["limit", "reclaim"].map((v) => (
                        <div key={v} style={{ marginTop: 6 }}>
                          <b>{v}</b> recent backtest trades: {(r.recentTrades?.[v] || []).map((t) => (
                            <span key={t.date} className={t.r >= 0 ? "up" : "down"} style={{ marginRight: 8 }}>{t.date} {rTxt(t.r)} ({t.exit})</span>
                          ))}
                          {!(r.recentTrades?.[v] || []).length && <span className="muted">none</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
          Backtest uses only completed daily bars and only what was known before each bar. Where one bar touched both stop and target it counts as the stop;
          exits are target, stop, or 10 bars. No slippage or commissions. Most symbols have under 10 trades per variant, so treat per-symbol numbers as a
          shortlist, not proof. Fit (0–100) weighs how often sweeps happen, how often they reclaim, and the better variant's shrunk expectancy.
        </div>
      </div>
    </>
  );
}
