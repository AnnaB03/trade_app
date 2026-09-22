"use client";
import { useState, useEffect, useCallback } from "react";

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const pctFmt = (v) => v == null ? "—" : (v * 100).toFixed(0) + "%";
const rFmt = (v) => v == null ? "" : ` · avg R ${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const money = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);

// One h1 / d1 / final grade badge: ✓/✗ on direction, R multiple if known.
function GradeBadge({ label, g }) {
  if (!g) return <span className="muted mono" style={{ fontSize: 11 }}>{label} —</span>;
  const cls = g.correct === true ? "up" : g.correct === false ? "down" : "muted";
  return (
    <span className={cls + " mono"} style={{ fontSize: 11, fontWeight: 600 }} title={`${label}: $${g.price?.toFixed(2)} · ${g.movePct >= 0 ? "+" : ""}${g.movePct?.toFixed(1)}%`}>
      {label} {g.correct === true ? "✓" : g.correct === false ? "✗" : "?"}{g.r != null ? ` ${g.r >= 0 ? "+" : ""}${g.r.toFixed(1)}R` : ""}
    </span>
  );
}

function GroupTable({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      {rows.slice(0, 6).map((r) => (
        <div key={r.key} className="mono muted" style={{ fontSize: 12, padding: "3px 0", display: "flex", gap: 8, justifyContent: "space-between" }}>
          <span style={{ color: "var(--ink)" }}>{r.key}</span>
          <span className={r.winRate >= 0.5 ? "up" : "down"}>{pctFmt(r.winRate)} (n={r.n}){rFmt(r.avgR)}</span>
        </div>
      ))}
    </div>
  );
}

export default function TrackRecord() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [openDays, setOpenDays] = useState(null); // null = "not yet defaulted"

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setData(await getJSON("/api/grade")); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const c = data?.calibration;
  const ideas = (data?.ideas || []).filter((i) => ["CALL", "PUT", "BUY", "SELL"].includes(i.action));

  // Grouped by day, not truncated to a flat row count — a single active day
  // can easily run 300+ ideas (every refresh × every symbol), so a fixed
  // slice used to cut off before even one full day was visible. The API
  // itself now serves a date window (default 3 days); this just makes that
  // volume readable instead of one giant table.
  const byDay = new Map();
  for (const i of ideas) {
    const day = new Date(i.createdAt).toLocaleDateString();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }
  const days = [...byDay.keys()]; // ideas is already newest-first, so insertion order = newest-day-first
  // Default to "most recent day open" the first time real data arrives —
  // can't do this as a useState initializer, since data loads async and
  // `days` is empty on the very first render.
  useEffect(() => {
    if (openDays == null && days.length) setOpenDays(new Set(days.slice(0, 1)));
  }, [days.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const isOpen = (day) => openDays == null ? false : openDays.has(day);
  const toggleDay = (day) => setOpenDays((s) => { const n = new Set(s || []); n.has(day) ? n.delete(day) : n.add(day); return n; });

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span className="label" style={{ margin: 0 }}>Track record · every AI idea, graded automatically</span>
          <button className="btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
        {err && <div className="err">{err}</div>}
        {!c && !err && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
        {c && (
          <>
            <div className="metrics">
              <div className="metric"><div className="k">Ideas logged (60d)</div><div className="v">{c.nTotal}</div></div>
              <div className="metric"><div className="k">Graded so far</div><div className="v">{c.nGraded}</div></div>
              <div className="metric">
                <div className="k">Overall hit rate</div>
                <div className="v" style={{ color: c.overall?.winRate >= 0.5 ? "var(--bull)" : c.overall ? "var(--bear)" : "var(--ink)" }}>
                  {c.overall ? pctFmt(c.overall.winRate) : "—"}
                </div>
              </div>
            </div>
            {c.nGraded < 5 && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
                Fewer than 5 graded ideas so far — this is day one. Ideas grade themselves at +1 hour, +1 day, and at expiration (or ~5 days out for share ideas) as you keep opening this app.
              </div>
            )}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
              Grading samples the price AT the checkpoint, not the path to get there — a trade that breached its stop and later recovered can grade as a "win" here even though a real stop order would have closed it at a loss first. Worth a skeptical read on any volatile, thin-float name.
            </div>
            <GroupTable title="By catalyst" rows={c.byCatalyst} />
            <GroupTable title="By symbol" rows={c.bySymbol} />
            <GroupTable title="By market regime (SPY trend)" rows={c.byRegimeTrend} />
            <GroupTable title="By opening drive (with/against the 9:30-10:00 move)" rows={c.byOpeningDrive} />
            {c.byOpeningDrive?.length > 0 && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
                "with" = the idea's direction agreed with the symbol's own opening drive when it was made; "against" fought it.
                Below n=30 in both, this is just informational — the Ideas tab only starts capping countertrend conviction once
                there's enough graded history to justify it (see docs/opening-drive-plan.md).
              </div>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <span className="label" style={{ margin: 0 }}>Idea ledger · by day, most recent first{data?.days ? <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · last {data.days} days served</span> : ""}</span>
        </div>
        {!ideas.length && <div className="muted" style={{ fontSize: 13 }}>No graded ideas yet — visit the Ideas tab to generate some.</div>}
        {days.map((day) => {
          const dayIdeas = byDay.get(day);
          const graded = dayIdeas.map((i) => i.grades?.final || i.grades?.d1 || i.grades?.h1).filter((g) => g && g.correct != null);
          const wins = graded.filter((g) => g.correct).length;
          const open = isOpen(day);
          return (
            <div key={day} style={{ marginTop: 10 }}>
              <button className="chip" onClick={() => toggleDay(day)} style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", padding: "8px 12px" }}>
                <span>{open ? "▾" : "▸"} {day} · {dayIdeas.length} idea{dayIdeas.length === 1 ? "" : "s"}</span>
                <span className={graded.length ? (wins / graded.length >= 0.5 ? "up" : "down") : "muted"}>
                  {graded.length ? `${pctFmt(wins / graded.length)} of ${graded.length} graded` : "none graded yet"}
                </span>
              </button>
              {open && (
                <table style={{ marginTop: 4 }}>
                  <thead><tr>
                    <th style={{ textAlign: "left" }}>Time</th><th style={{ textAlign: "left" }}>Symbol</th>
                    <th style={{ textAlign: "left" }}>Plan</th><th>Catalyst</th><th>Conv.</th>
                    <th>Entry</th><th>+1h</th><th>+1d</th><th>Final</th>
                  </tr></thead>
                  <tbody>
                    {dayIdeas.map((i) => (
                      <tr key={i.id}>
                        <td style={{ textAlign: "left" }} className="muted">{new Date(i.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                        <td style={{ textAlign: "left", fontWeight: 600 }}>{i.symbol}</td>
                        <td style={{ textAlign: "left" }} title={i.why_plain || ""}>
                          {i.action}{i.vehicle === "OPTION" ? ` ${i.strike ?? ""} ${i.expiration ?? ""}` : i.vehicle === "SHARES" ? " shares" : ""}
                          {i.invalidation != null && i.target != null && (
                            <span className="muted"> · stop {money(i.invalidation)} → target {money(i.target)}</span>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{i.catalyst || "—"}</td>
                        <td className="mono">{i.conviction ?? "—"}</td>
                        <td className="mono">{money(i.entryPrice)}</td>
                        <td><GradeBadge label="" g={i.grades?.h1} /></td>
                        <td><GradeBadge label="" g={i.grades?.d1} /></td>
                        <td><GradeBadge label="" g={i.grades?.final} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
