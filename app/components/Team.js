"use client";
import { useState, useEffect, useCallback, Fragment } from "react";

/* The agent team's reports (app/api/agentsLib.js): the risk & market brief
   before the open, its midday and post-release reads, QA and performance
   after the close. Read-only agents; this tab only shows what they wrote. */
const ORDER = ["risk-market-analyst", "qa", "performance-analyst"];
const SCHEDULE = {
  "risk-market-analyst": "8:45 brief · 12:30 midday · 15 min after a big release",
  qa: "16:20 after the close",
  "performance-analyst": "16:35 daily · weekly review on Fridays",
};
const RUN_MODES = { "risk-market-analyst": ["brief", "midday"], qa: ["daily"], "performance-analyst": ["daily", "weekly"] };

// A small renderer for the agents' plain markdown: headings, bullets, **bold**, ALERT lines.
function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") ? <code key={i} className="mono">{part.slice(1, -1)}</code>
      : <Fragment key={i}>{part}</Fragment>);
}
function Report({ body }) {
  const lines = String(body || "").split("\n");
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
      {lines.map((l, i) => {
        if (!l.trim()) return <div key={i} style={{ height: 6 }} />;
        if (/^\s*(?:[-*]\s*)?\**ALERT:?/i.test(l)) return <div key={i} className="err" style={{ margin: "6px 0" }}>{inline(l.replace(/^\s*[-*]\s*/, ""))}</div>;
        const h = /^(#{1,4})\s+(.*)$/.exec(l);
        if (h) return <div key={i} style={{ fontFamily: "var(--serif)", fontSize: h[1].length === 1 ? 19 : 16, margin: "10px 0 4px" }}>{inline(h[2])}</div>;
        const b = /^(\s*)[-*]\s+(.*)$/.exec(l);
        if (b) return <div key={i} style={{ paddingLeft: 14 + b[1].length * 6, textIndent: -10 }}>· {inline(b[2])}</div>;
        if (/^\|/.test(l)) return <div key={i} className="mono" style={{ fontSize: 12, whiteSpace: "pre", overflowX: "auto" }}>{l}</div>;
        return <div key={i}>{inline(l)}</div>;
      })}
    </div>
  );
}

export default function Team() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agents?limit=40");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setData(d); setErr("");
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const run = async (role, mode) => {
    setMsg("");
    const r = await fetch(`/api/agents?run=${role}&mode=${mode}`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `${data?.roles?.[role]?.label ?? role} started (${mode}). The report appears here when it finishes, usually in 3 to 10 minutes.` : (d.reason || d.error || "Could not start it."));
    load();
  };

  const reports = data?.reports || [];
  const latest = (role) => reports.find((r) => r.role === role);
  const shown = open ? reports.find((r) => r.file === open) : null;

  return (
    <>
      {err && <div className="err">Couldn&apos;t load the team&apos;s reports: {err}</div>}
      <div className="card">
        <span className="label">The team · read-only agents that report; the Cockpit still makes every trade</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {ORDER.map((role) => {
            const l = latest(role), info = data?.roles?.[role];
            const alerts = l ? (l.body.match(/^\s*(?:[-*]\s*)?\**ALERT/gim) || []).length : 0;
            return (
              <div key={role} style={{ border: "1px solid var(--line)", borderRadius: 3, padding: 12, background: "var(--paper)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <strong>{info?.label ?? role}</strong>
                  {info?.running ? <span className="badge">running…</span> : alerts ? <span className="badge down">{alerts} alert{alerts > 1 ? "s" : ""}</span> : null}
                </div>
                <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>{SCHEDULE[role]}</div>
                <div style={{ fontSize: 12.5, marginBottom: 8 }}>
                  {l ? <button className="chip" onClick={() => setOpen(l.file)}>Last: {l.mode} · {l.dateET} {l.timeET} ET</button> : <span className="muted">No report yet</span>}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {RUN_MODES[role].map((m) => (
                    <button key={m} className="chip" disabled={info?.running} onClick={() => run(role, m)} title="Starts this agent now (billed)">Run {m} now</button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {msg && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{msg}</div>}
      </div>

      {shown && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <span className="label" style={{ margin: 0 }}>{data?.roles?.[shown.role]?.label ?? shown.role} · {shown.mode} · {shown.dateET} {shown.timeET} ET</span>
            <button className="chip" onClick={() => setOpen(null)}>Close</button>
          </div>
          <Report body={shown.body} />
        </div>
      )}

      <div className="card">
        <span className="label">All reports, newest first</span>
        {!reports.length && <div className="muted" style={{ fontSize: 13 }}>Nothing yet. The first brief runs at 8:45 ET on the next trading day.</div>}
        {reports.map((r) => (
          <div key={r.file} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13, cursor: "pointer" }} onClick={() => setOpen(r.file)}>
            <span className="mono" style={{ width: 130, flexShrink: 0 }}>{r.dateET} {r.timeET}</span>
            <span style={{ width: 120, flexShrink: 0 }}>{data?.roles?.[r.role]?.label ?? r.role}</span>
            <span className="muted">{r.mode}</span>
            {/^\s*(?:[-*]\s*)?\**ALERT/im.test(r.body) && <span className="badge down" style={{ marginLeft: "auto" }}>alert</span>}
          </div>
        ))}
      </div>
    </>
  );
}
