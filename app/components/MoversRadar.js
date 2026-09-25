"use client";
import { useState, useEffect, useCallback, useRef } from "react";

/* Deterministic movers scanner UI — polls /api/moversRadar (no LLM in that
   loop) every 60s. See app/api/moversRadar/route.js for the classification
   logic (CONTINUATION / FADE / WATCH from RVOL, float rotation, and a live
   VWAP read). Built to catch the 100%+ movers the main Ideas engine's tiny
   coverage cap used to miss entirely. */

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const TYPE_COLOR = { CONTINUATION: "var(--bull)", FADE: "var(--bear)", WATCH: "var(--muted)" };
const TYPE_ICON = { CONTINUATION: "🟢", FADE: "🔴", WATCH: "🟡" };

function MoverCard({ m, onPick }) {
  const color = TYPE_COLOR[m.classification.type] || "var(--muted)";
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontWeight: 600, cursor: onPick ? "pointer" : "default" }} onClick={() => onPick?.(m.symbol)}>
          {TYPE_ICON[m.classification.type]} {m.symbol}
          <span className={m.changePct >= 0 ? "up" : "down"} style={{ marginLeft: 8, fontWeight: 600 }}>
            {m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(1)}%
          </span>
        </span>
        <span className="badge" style={{ color, borderColor: color }}>{m.classification.type}</span>
      </div>
      <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>
        ${m.price?.toFixed(2)}
        {m.rvol != null && <> · {m.rvol.toFixed(1)}x RVOL</>}
        {m.floatRotation != null && <> · {(m.floatRotation * 100).toFixed(0)}% float rotation</>}
        {m.state?.offHighPct != null && <> · {m.state.offHighPct >= -0.5 ? "at" : `${Math.abs(m.state.offHighPct).toFixed(1)}% off`} today's high</>}
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{m.classification.note}</div>
      {m.headline?.title && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
          <a href={m.headline.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{m.headline.title}</a> — {m.headline.site}
        </div>
      )}
    </div>
  );
}

export default function MoversRadar({ onPick, visible = true }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const seenContinuationRef = useRef(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJSON("/api/moversRadar");
      setData(d); setErr("");
      // Alert once per symbol the first time it becomes a CONTINUATION —
      // that's the actionable state; repeating it every 60s would be noise.
      const fresh = (d.movers || []).filter((m) => m.classification.type === "CONTINUATION" && !seenContinuationRef.current.has(m.symbol));
      for (const m of fresh) {
        seenContinuationRef.current.add(m.symbol);
        try {
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`🟢 ${m.symbol} continuation`, { body: `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(0)}% — ${m.classification.note}`, tag: `mover-${m.symbol}` });
          }
        } catch {}
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Stays mounted across tab switches now (see page.js) — this only gates
  // active polling, not the component's lifetime, so `data` survives a
  // switch away and back instead of resetting to a blank loading state.
  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, visible]);

  const movers = data?.movers || [];
  const continuation = movers.filter((m) => m.classification.type === "CONTINUATION");
  const watch = movers.filter((m) => m.classification.type === "WATCH");
  const fade = movers.filter((m) => m.classification.type === "FADE");

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span className="label" style={{ margin: 0 }}>Movers Radar · deterministic, no AI call — refreshes every 60s</span>
        <button className="btn" onClick={load} disabled={loading}>{loading ? "…" : "Refresh"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {data && !data.available && <div className="muted" style={{ fontSize: 13 }}>{data.reason}</div>}
      {data?.available && !movers.length && <div className="muted" style={{ fontSize: 13 }}>Nothing moving 15%+ right now.</div>}

      {continuation.length > 0 && (
        <>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: 0.5, marginTop: 4 }}>🟢 CONTINUATION — still running, held a pullback, real volume</div>
          {continuation.map((m) => <MoverCard key={m.symbol} m={m} onPick={onPick} />)}
        </>
      )}
      {watch.length > 0 && (
        <>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: 0.5, marginTop: 14 }}>🟡 WATCH — moving, no clean signature yet</div>
          {watch.map((m) => <MoverCard key={m.symbol} m={m} onPick={onPick} />)}
        </>
      )}
      {fade.length > 0 && (
        <>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: 0.5, marginTop: 14 }}>🔴 FADE — parabolic phase looks over</div>
          {fade.map((m) => <MoverCard key={m.symbol} m={m} onPick={onPick} />)}
        </>
      )}
    </div>
  );
}
