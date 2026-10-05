/* ---------- Calibration: turning graded ideas into a feedback signal ----------
   Groups by the dimension that plausibly predicts a repeatable edge, using
   the best available grade per idea (final > d1 > h1). n < 3 groups are
   dropped — not enough to say anything. */
/* The grade whose HORIZON matches what the idea actually was.
   This used to prefer `final`, and that single preference made the model
   long-only. Ideas here carry staleMinutes of 60-240 — one to four hours —
   but `final` is graded a median of 6.7 days after the idea was written
   (max 10.9). Over a week, the grade stops measuring the idea and starts
   measuring the market's drift, which is not symmetric: in a rising tape it
   flatters every long and destroys every short.
   Measured on the real ledger, same ideas, by horizon:
     BULLISH  h1 42.4%/+0.23  d1 57.0%/+0.61  final 61.7%/+0.82  (n=330)
     BEARISH  h1 23.5%/-0.66  d1 51.8%/+0.24  final  9.1%/-3.56  (n=85)
   At d1 the two directions are 5 points apart. At `final` they are 52 apart,
   and that gap is manufactured entirely by the horizon. One real example: a
   SELL written 2026-09-14 was graded 2026-09-22 against a +19.3% move, -6.7R.
   The consequence fed straight into the prompt as settled fact, because
   n=76 clears the provisional threshold: "technical breakdown 22% (n=76,
   avgR -2.14)". Told its bearish catalyst loses 78% of the time, the model
   stopped proposing bearish setups — zero PUT/SELL ideas across nine
   consecutive refreshes — which then produced no new bearish grades, so the
   number could never correct itself. A self-reinforcing loop.
   d1 first: it is the horizon these ideas are actually built for, it exists
   on every graded idea (n=76 against 43 for final), and it matches the
   day-trading orientation this book is run on. h1 next, still inside an
   idea's own staleness window. `final` last — a multi-day drift measure is a
   different question and must not be the headline number. */
function bestGrade(idea) {
  return idea.grades?.d1 || idea.grades?.h1 || idea.grades?.final || null;
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
    byStrategy: groupStats(rows, (i) => i.strategy || "ai"),
    byCatalyst: groupStats(rows, (i) => i.catalyst || null),
    bySymbol: groupStats(rows, (i) => i.symbol || null),
    byRegimeTrend: groupStats(rows, (i) => i.regimeTrend || null),
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
  // A group under this many graded ideas is still noisy enough that a
  // single string of bad luck (or, since grading is point-in-time not
  // path-aware, a stop that was hit and recovered before the checkpoint —
  // see gradeLib.js) can produce a number that reads as a verdict but isn't
  // one. Tagged "provisional" past this threshold instead of stated flatly —
  // confirmed live: a QQQ "46%, n=28" line was cited as the reason for 16
  // straight index WAITs on a day the tape itself was a clean trend.
  const PROVISIONAL_BELOW_N = 40;
  const fmtGroup = (label, rows) => rows.length
    ? `${label}: ` + rows.slice(0, 4).map((r) => `${r.key} ${(r.winRate * 100).toFixed(0)}% (n=${r.n}${r.avgR != null ? `, avgR ${r.avgR.toFixed(2)}` : ""})${r.n < PROVISIONAL_BELOW_N ? " [provisional — small sample, don't treat as settled]" : ""}`).join("; ")
    : null;
  const lines = [
    calib.overall ? `Overall track record: ${(calib.overall.winRate * 100).toFixed(0)}% directionally correct over ${calib.overall.n} graded ideas${calib.overall.avgR != null ? `, avg R ${calib.overall.avgR.toFixed(2)}` : ""}.` : null,
    "Note on all groups below: grading is point-in-time (price at a fixed checkpoint), not path-aware — it can miss a stop that was hit and later recovered. A group under n=40 is marked [provisional]: real signal to weigh, not a hard veto on an otherwise good setup with today's actual data behind it.",
    fmtGroup("By catalyst", calib.byCatalyst),
    fmtGroup("By symbol", calib.bySymbol),
    fmtGroup("By market regime", calib.byRegimeTrend),
  ].filter(Boolean);
  return lines.join("\n");
}
