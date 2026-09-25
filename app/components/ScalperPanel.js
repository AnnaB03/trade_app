"use client";
import { useState, useEffect, useCallback, useRef } from "react";

/* Deterministic intraday SPY/SPX/XSP scalper panel — polls /api/scalper
   (no LLM in that loop) every 20s while the tab is open, since a 2-5 minute
   scalp needs an answer in seconds, not a ~60s Claude call. See
   app/api/scalper/route.js and app/lib/scalperMath.js for the actual math. */

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const money = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const pct = (v, dp = 2) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;

const REGIME_COLOR = {
  "TREND UP": "var(--bull)", "TREND DOWN": "var(--bear)",
  CHOP: "#7A5C15", MIXED: "var(--muted)", UNKNOWN: "var(--muted)",
};

function SymbolPicker({ symbol, setSymbol }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {["SPY", "XSP", "QQQ"].map((s) => (
        <button key={s} className="chip" style={symbol === s ? { borderColor: "var(--accent)", color: "var(--ink)" } : undefined} onClick={() => setSymbol(s)}>{s}</button>
      ))}
    </div>
  );
}

function ContractLine({ label, leg }) {
  if (!leg) return null;
  return (
    <div className="mono muted" style={{ fontSize: 12.5, marginTop: 4 }}>
      {label}: bid {money(leg.bid)} / ask {money(leg.ask)}{leg.delta != null ? ` · delta ${leg.delta.toFixed(2)}` : ""}
      {leg.hold5min && <> · 5-min hold cost ≈ {money(leg.hold5min.total)} ({leg.hold5min.totalPctOfMid?.toFixed(1)}% of mid)</>}
    </div>
  );
}

export default function ScalperPanel({ visible = true }) {
  const [symbol, setSymbol] = useState("SPY");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const lastSignalRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJSON(`/api/scalper?symbol=${symbol}`);
      setData(d); setErr("");
      // Alert only on a genuine state change into a real signal, not every
      // poll — a BUY CALL held across three consecutive 20s polls should
      // chime once, not three times.
      const sig = d?.signal?.action;
      if (sig && sig !== "NO TRADE" && lastSignalRef.current !== sig) {
        try {
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`⚡ ${symbol} scalper: ${sig}`, { body: d.signal.reason, tag: "scalper" });
          }
        } catch {}
      }
      lastSignalRef.current = sig || null;
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  // Stays mounted across tab switches now (see page.js) so `data` survives
  // — this only controls whether it's actively POLLING. Paused while
  // hidden so a background tab isn't hitting Tradier every 20s for no
  // reason; refreshes immediately the moment it becomes visible again
  // rather than waiting out a full interval on stale data.
  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load, visible]);

  const regimeColor = data?.regime ? (REGIME_COLOR[data.regime.state] || "var(--muted)") : "var(--muted)";
  const isBuy = data?.signal?.action && data.signal.action !== "NO TRADE";

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span className="label" style={{ margin: 0 }}>
          Index Scalper · deterministic, no AI call — refreshes every 20s{data?.nowET ? ` · ${data.nowET} ET` : ""}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <SymbolPicker symbol={symbol} setSymbol={setSymbol} />
          <button className="btn" onClick={load} disabled={loading}>{loading ? "…" : "Refresh"}</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {!data && !err && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
      {data && !data.available && <div className="muted" style={{ fontSize: 13 }}>{data.reason}</div>}

      {data?.available && (
        <>
          <div style={{
            padding: "12px 14px", borderRadius: 4, marginBottom: 12,
            border: `1.5px solid ${isBuy ? regimeColor : "var(--line)"}`,
            background: isBuy ? "rgba(0,0,0,.03)" : "transparent",
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: isBuy ? regimeColor : "var(--ink)" }}>
              {isBuy ? `⚡ ${data.signal.action}` : "No trade right now"}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{data.signal.reason}</div>
            {data.signal.contract && (
              <div className="mono" style={{ fontSize: 12.5, marginTop: 6 }}>
                {data.signal.contract.type} {data.signal.contract.strike} exp {data.signal.contract.expiration} — ask {money(data.signal.contract.ask)}
                {data.signal.hold5minCost && <> · 5-min hold cost ≈ {money(data.signal.hold5minCost.total)} ({data.signal.hold5minCost.totalPctOfMid?.toFixed(1)}%)</>}
              </div>
            )}
          </div>

          <div className="metrics">
            <div className="metric">
              <div className="k">Regime</div>
              <div className="v" style={{ color: regimeColor, fontSize: 16 }}>{data.regime.state}</div>
            </div>
            <div className="metric"><div className="k">Spot</div><div className="v">{money(data.spot)}</div></div>
            <div className="metric"><div className="k">Opening range</div><div className="v" style={{ fontSize: 14 }}>{data.openingRange ? `${data.openingRange.low.toFixed(2)}–${data.openingRange.high.toFixed(2)}` : "—"}</div></div>
            <div className="metric">
              <div className="k">Window</div>
              <div className="v" style={{ fontSize: 13, color: data.window.tradable ? "var(--ink)" : "var(--bear)" }}>{data.window.label}</div>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{data.regime.detail}</div>

          {data.pullback?.state && data.pullback.state !== "N/A" && data.pullback.state !== "UNKNOWN" && (
            <div className="mono" style={{ fontSize: 12.5, marginTop: 4 }}>Entry state: <b>{data.pullback.state}</b> — {data.pullback.detail}</div>
          )}

          {Object.keys(data.leaders || {}).some((k) => data.leaders[k]) && (
            <div className="mono muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              Leaders: {Object.entries(data.leaders).map(([s, l]) => l ? `${s} ${pct(l.chg)} ${l.agrees ? "✓" : "✗"}` : `${s} —`).join(" · ")}
            </div>
          )}

          {data.eventLock?.next && (
            <div className="warn" style={{ marginTop: 10, fontSize: 12.5 }}>
              {data.eventLock.locked
                ? `LOCKED — ${data.eventLock.active.label} at ${data.eventLock.active.timeET} ET`
                : `Next: ${data.eventLock.next.label} at ${data.eventLock.next.timeET} ET (${data.eventLock.next.inMinutes} min) — no entries within 5 min before / 3 min after`}
            </div>
          )}

          {data.atm && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <div className="mono muted" style={{ fontSize: 11.5, letterSpacing: 0.5 }}>ATM {data.atm.strike} · exp {data.atm.expiration}</div>
              <ContractLine label="Call" leg={data.atm.call} />
              <ContractLine label="Put" leg={data.atm.put} />
              {data.pin && (data.pin.callWall || data.pin.putWall) && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Near-spot pin: {data.pin.callWall ? `call wall ${data.pin.callWall.strike} (OI ${data.pin.callWall.oi.toLocaleString()})` : ""}
                  {data.pin.callWall && data.pin.putWall ? " · " : ""}
                  {data.pin.putWall ? `put wall ${data.pin.putWall.strike} (OI ${data.pin.putWall.oi.toLocaleString()})` : ""}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
