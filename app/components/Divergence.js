"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { divergence } from "../lib/metrics";

const DEFAULT_SYMS = ["SPY", "QQQ", "NVDA", "TSLA", "AMD"];

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

export default function Divergence() {
  const [rows, setRows] = useState([]);
  const [manual, setManual] = useState({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_sentiment"));
      if (saved && typeof saved === "object") setManual(saved);
    } catch {}
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("cockpit_sentiment", JSON.stringify(manual)); } catch {}
  }, [manual]);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    let syms = DEFAULT_SYMS;
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_watch"));
      if (Array.isArray(saved) && saved.length) syms = saved;
    } catch {}
    try {
      const data = await Promise.all(syms.map(async (sym) => {
        const [hist, sent] = await Promise.all([
          getJSON(`/api/history?symbol=${sym}&days=30`).catch(() => null),
          getJSON(`/api/sentiment?symbol=${sym}`).catch(() => null),
        ]);
        return {
          sym,
          price30: hist?.change_pct ?? null,
          autoSent: sent?.available ? sent.sentiment : null,
          reason: sent?.available ? null : sent?.reason,
        };
      }));
      setRows(data);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const computed = rows.map((r) => {
    const manualVal = manual[r.sym] !== undefined && manual[r.sym] !== "" ? Number(manual[r.sym]) : null;
    const sentiment = manualVal ?? r.autoSent;
    const source = manualVal != null ? "manual" : r.autoSent != null ? "auto" : null;
    const d = divergence(r.price30, sentiment);
    return { ...r, sentiment, source, d };
  }).sort((a, b) => Math.abs(b.d?.score ?? -1) - Math.abs(a.d?.score ?? -1));

  const anyAuto = rows.some((r) => r.autoSent != null);

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Divergence · 30-day tape vs. crowd · watchlist symbols</span>
        <button className="btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {!anyAuto && rows.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Sentiment feed unavailable ({rows.find((r) => r.reason)?.reason || "no data"}) — enter crowd sentiment 0–100 manually per ticker; 50 = neutral.
        </div>
      )}
      <table>
        <thead><tr>
          <th style={{ textAlign: "left" }}>Symbol</th><th>Price 30d</th><th>Sentiment (0–100)</th><th>Score</th>
          <th style={{ textAlign: "left" }}>Read</th>
        </tr></thead>
        <tbody>
          {computed.map((r) => (
            <tr key={r.sym}>
              <td style={{ textAlign: "left", fontWeight: 600 }}>{r.sym}</td>
              <td className={r.price30 == null ? "muted" : r.price30 < 0 ? "down" : "up"}>
                {r.price30 == null ? "—" : (r.price30 >= 0 ? "+" : "") + r.price30.toFixed(1) + "%"}
              </td>
              <td>
                <input className="in" style={{ width: 64, padding: "3px 6px", fontSize: 12, textAlign: "right" }}
                  inputMode="decimal" placeholder={r.autoSent != null ? r.autoSent.toFixed(0) : "50"}
                  value={manual[r.sym] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.]/g, "");
                    setManual((m) => ({ ...m, [r.sym]: v === "" ? undefined : Math.min(100, Number(v)) }));
                  }} />
                {r.source && <span className="muted" style={{ fontSize: 10, marginLeft: 5 }}>{r.source}</span>}
              </td>
              <td className="mono">{r.d ? r.d.score.toFixed(2) : "—"}</td>
              <td style={{ textAlign: "left", fontSize: 12 }}
                className={r.d?.label.startsWith("CROWD") ? "down" : r.d?.label.startsWith("TAPE") ? "up" : "muted"}>
                {r.d ? r.d.label : "needs sentiment"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Score = capped 30-day price move (±15% → ±1) minus crowd sentiment (0–100 → −1…+1). |score| ≥ 0.6 flags disagreement.
      </div>
    </div>
  );
}
