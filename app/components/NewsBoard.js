"use client";
import { useState, useEffect, useCallback } from "react";
import { classifyCatalyst, headlineAgeHours, ageRead } from "../lib/checks";

const DEFAULT_SYMS = ["SPY", "SPX", "QQQ", "NVDA", "TSLA", "AMD"];

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

function watchSyms() {
  try {
    const saved = JSON.parse(localStorage.getItem("cockpit_watch"));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return DEFAULT_SYMS;
}

const WEIGHT_TONE = { high: "up", medium: "", low: "muted", bearish: "down", unknown: "muted" };

/* Always-visible news + calendar — this used to exist only inside the
   Overnight Brief, which only renders while the market is fully closed, so
   it disappeared the moment the session opened. This tab shows the same
   underlying data (plus a wider earnings window and catalyst classification
   on every headline) regardless of market state. */
export default function NewsBoard({ onPick }) {
  const [cal, setCal] = useState(null);
  const [articles, setArticles] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    const list = watchSyms().slice(0, 10).join(",");
    try {
      const [c, n] = await Promise.all([
        getJSON(`/api/today?symbols=${list}&days=21`),
        getJSON(`/api/news?symbols=${list}&limit=3`),
      ]);
      setCal(c.available ? c : { unavailable: true, reason: c.reason });
      setArticles(n.articles || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const classified = (articles || [])
    .map((a) => ({ ...a, cat: classifyCatalyst(a.title), ageH: headlineAgeHours(a.publishedDate) }))
    .sort((a, b) => (a.ageH ?? 1e9) - (b.ageH ?? 1e9));

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span className="label" style={{ margin: 0 }}>Calendar · macro releases &amp; earnings on your watchlist, next 21 days</span>
          <button className="chip" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
        {err && <div className="err">{err}</div>}
        {!cal && !err && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
        {cal?.unavailable && <div className="muted" style={{ fontSize: 13 }}>Calendar unavailable — {cal.reason || "FMP_API_KEY not set"}.</div>}
        {cal && !cal.unavailable && (
          <>
            {cal.effects?.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                {cal.effects.map((e) => (
                  <span key={e} className="badge" style={{ color: "#7A5C15", borderColor: "rgba(163,120,32,.5)" }}>{e}</span>
                ))}
              </div>
            )}
            {cal.macroUpcoming?.length > 0 && (
              <>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700, margin: "4px 0 2px" }}>Macro releases</div>
                {cal.macroUpcoming.map((m) => (
                  <div key={m.label + m.date} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", fontSize: 13, gap: 8 }}>
                    <span>{m.label}{m.timeET ? ` · ${m.timeET} ET` : ""}</span>
                    <span className={m.when === "today" ? "up" : "muted"} style={{ fontWeight: m.when === "today" ? 600 : 400, whiteSpace: "nowrap" }}>{m.when}</span>
                  </div>
                ))}
              </>
            )}
            {cal.earnings?.length > 0 && (
              <>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700, margin: "14px 0 2px" }}>Earnings on your watchlist</div>
                {cal.earnings.map((e) => (
                  <div key={e.symbol + e.date} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, gap: 8 }}>
                    <button className="chip" style={{ padding: "2px 8px", fontWeight: 700 }} onClick={() => onPick?.(e.symbol)}>{e.symbol}</button>
                    <span className={e.when === "today" ? "up" : "muted"} style={{ fontWeight: e.when === "today" ? 600 : 400, whiteSpace: "nowrap" }}>{e.when}</span>
                  </div>
                ))}
              </>
            )}
            {!cal.macroUpcoming?.length && !cal.earnings?.length && !cal.effects?.length && (
              <div className="muted" style={{ fontSize: 13 }}>Nothing scheduled on your watchlist in the next 21 days.</div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <span className="label">Headlines · your watchlist, classified by catalyst weight</span>
        {!classified.length && <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>No recent headlines.</div>}
        {classified.map((a) => (
          <div key={`${a.symbol}-${a.url || a.title}`} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <button className="chip" style={{ padding: "2px 8px", fontWeight: 700 }} onClick={() => onPick?.(a.symbol)}>{a.symbol}</button>
              <span className={"badge " + (WEIGHT_TONE[a.cat?.weight] || "")} style={{ fontSize: 10.5 }}>{a.cat?.kind || "unknown"}</span>
              <span className="muted mono" style={{ fontSize: 11 }}>{a.ageH != null ? ageRead(a.ageH) : ""}</span>
            </div>
            <div style={{ fontSize: 13.5, marginTop: 4 }}>{a.title}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{a.site}</div>
          </div>
        ))}
      </div>
    </>
  );
}
