/* ---------- Calibration: turning graded ideas into a feedback signal ----------
   Groups by the dimension that plausibly predicts a repeatable edge, using
   the best available grade per idea (final > d1 > h1). n < 3 groups are
   dropped — not enough to say anything. */
function bestGrade(idea) {
  return idea.grades?.final || idea.grades?.d1 || idea.grades?.h1 || null;
}

// A real R-multiple can still be a legitimate outlier — a 480% squeeze on a
// thin penny name graded +78R is mathematically correct, not a data bug like
// the near-zero-stop case gradeLib guards against. But one trade that size
// would single-handedly dominate any average it's folded into, making the
// aggregate read as "this category is great" when it's really "one freak win
// plus a lot of ordinary losses." Winsorize at ±5R for AVERAGING only — win
// rate (a plain correct/incorrect count) is unaffected, so a huge win still
// counts as a full win, it just stops distorting the magnitude of the average.
const R_CLAMP = 5;
const clampR = (r) => Math.max(-R_CLAMP, Math.min(R_CLAMP, r));

function groupStats(rows, keyFn) {
  const groups = new Map();
  for (const idea of rows) {
    const g = bestGrade(idea);
    if (!g || g.correct == null) continue;
    const key = keyFn(idea);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const out = [];
  for (const [key, grades] of groups) {
    if (grades.length < 3) continue;
    const wins = grades.filter((g) => g.correct).length;
    const rs = grades.filter((g) => g.r != null).map((g) => clampR(g.r));
    out.push({
      key, n: grades.length,
      winRate: wins / grades.length,
      avgR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

export function computeCalibration(ideas, { sinceDays = 60 } = {}) {
  const cutoff = Date.now() - sinceDays * 86400000;
  const rows = ideas.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
  const graded = rows.filter((i) => bestGrade(i));
  const overall = groupStats(rows, () => "all")[0] || null;

  return {
    nTotal: rows.length,
    nGraded: graded.length,
    overall,
    byCatalyst: groupStats(rows, (i) => i.catalyst || null),
    bySymbol: groupStats(rows, (i) => i.symbol || null),
    byRegimeTrend: groupStats(rows, (i) => i.regimeTrend || null),
    // "with"/"against"/"flat" the symbol's own 9:30-10:00 opening drive at
    // the moment the idea was made (see app/api/openingDriveLib.js). This is
    // the evidence Phase 4 (driveGateActive, below) needs before any hard
    // rule is allowed to act on it.
    byOpeningDrive: groupStats(rows, (i) => i.driveAligned || null),
    byHour: groupStats(rows, (i) => {
      const h = new Date(i.createdAt).getUTCHours();
      // Bucket into ET-ish 2-hour windows for readability (rough, no DST math needed for a bucket label).
      return `${Math.floor(h / 2) * 2}:00-${Math.floor(h / 2) * 2 + 2}:00 UTC`;
    }),
  };
}

// Short text block for the model prompt — only the dimensions with signal.
export function calibrationText(calib) {
  if (!calib || calib.nGraded < 5) {
    return `Track record: only ${calib?.nGraded ?? 0} graded ideas so far in the last 60 days — not enough yet to calibrate on. Treat this as day one.`;
  }
  const fmtGroup = (label, rows) => rows.length
    ? `${label}: ` + rows.slice(0, 4).map((r) => `${r.key} ${(r.winRate * 100).toFixed(0)}% (n=${r.n}${r.avgR != null ? `, avgR ${r.avgR.toFixed(2)}` : ""})`).join("; ")
    : null;
  const lines = [
    calib.overall ? `Overall track record: ${(calib.overall.winRate * 100).toFixed(0)}% directionally correct over ${calib.overall.n} graded ideas${calib.overall.avgR != null ? `, avg R ${calib.overall.avgR.toFixed(2)}` : ""}.` : null,
    fmtGroup("By catalyst", calib.byCatalyst),
    fmtGroup("By symbol", calib.bySymbol),
    fmtGroup("By market regime", calib.byRegimeTrend),
    fmtGroup("By opening drive", calib.byOpeningDrive),
  ].filter(Boolean);
  return lines.join("\n");
}

/* ---------- Phase 4: the hard gate, data-driven not scheduled ----------
   Do NOT cap conviction on an against-the-drive idea until this app's own
   ledger has enough graded evidence that it actually matters. Requires at
   least 30 graded ideas in BOTH "with" and "against" (the same n-floor
   groupStats already applies at n>=3 is far too low to act on), and a real
   gap in win rate before it flips on. Self-activates the moment the ledger
   crosses the threshold; there is nothing to toggle by hand. */
const GATE_MIN_N = 30;
const GATE_MIN_GAP = 0.10; // 10 percentage points

export function driveGateActive(calib) {
  const groups = Object.fromEntries((calib?.byOpeningDrive || []).map((g) => [g.key, g]));
  const withG = groups.with, against = groups.against;
  if (!withG || !against || withG.n < GATE_MIN_N || against.n < GATE_MIN_N) return false;
  return withG.winRate - against.winRate >= GATE_MIN_GAP;
}
