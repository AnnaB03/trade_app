"""Can a trend day be recognised by 10:30-11:00? (owner, 2026-10-30)

Builds one row per trading day from the saved weekly chains (fetch_chains.py):
QQQ's price every 15 minutes from put-call parity, the opening gap, the
opening-range break, SPY agreement, and the morning's implied move (the
at-the-money straddle). The outcome is what happened AFTER the check time:
did QQQ keep going its way by 15:45, and what did an at-the-money option
bought then in that direction make if held to 15:45 (sized to $500 at a 20%
stop, the stop optional)?

    python3 scripts/backtest/trend_detect.py            # builds data/backtest/days.json, then scores
"""
import glob, json, os, sys, datetime as dt, statistics
sys.path.insert(0, os.path.dirname(__file__))
from credit_spreads import load, spot, nearest_strike, DATA

OUT = os.path.join(DATA, "days.json")
CHECKS = ("10:30", "11:00")


def days_from_chains(sym):
    """{date: {"times": [...], "s": {t: spot}, "q": chain quotes}} using, per day, the nearest expiry >= 1 day out."""
    by_day = {}
    for f in sorted(glob.glob(os.path.join(DATA, f"{sym}_*.json.gz"))):
        _, exp, q = load(f)
        days = sorted({t[:10] for qs in q.values() for t in qs})
        for d in days:
            if d >= exp.isoformat():
                continue                                    # need at least one day to expiry
            if d not in by_day or by_day[d][0] > exp:       # keep the nearest such expiry
                by_day[d] = (exp, q)
    return by_day


def build():
    rows = []
    qqq, spy = days_from_chains("QQQ"), days_from_chains("SPY")
    dates = sorted(qqq)
    prev_close = None
    for d in dates:
        exp, q = qqq[d]
        times = sorted({t for qs in q.values() for t in qs if t[:10] == d})
        s = {t[11:]: spot(q, t) for t in times}
        s = {k: v for k, v in s.items() if v}
        if not s or "09:45" not in s and "09:30" not in s:
            prev_close = None
            continue
        o = s.get("09:30") or s.get("09:45")
        close = s.get("15:45") or s[max(s)]
        row = {"date": d, "exp": exp.isoformat(), "open": o, "close": close, "prev_close": prev_close,
               "orh": max(v for k, v in s.items() if k <= "10:00"), "orl": min(v for k, v in s.items() if k <= "10:00")}
        for c in CHECKS:
            if c not in s:
                continue
            px = s[c]; k = nearest_strike(q, px)
            tc, tp = f"{d}T{c}", (k, "C")
            call, put = q.get((k, "C"), {}).get(tc), q.get((k, "P"), {}).get(tc)
            row[c] = {"px": px, "move": (px - o) / o * 100,
                      "straddle_pct": ((call[1] + put[1]) / px * 100) if call and put else None}
            # the aggressive play: buy the ATM option in the morning's direction at the ask, hold to 15:45
            right = "C" if px >= o else "P"
            oq = q.get((k, right), {})
            if tc in oq and oq[tc][1] > 0:
                ask = oq[tc][1]; n = 500 / (ask * 0.2 * 100)
                path = [(t[11:], b, a) for t, (b, a) in sorted(oq.items()) if t[:10] == d and t[11:] > c]
                hold = stop = None
                for t, b, a in path:
                    if stop is None and ((b + a) / 2 - ask) / ask <= -0.2:
                        stop = (b - ask) * 100 * n - 0.7 * n
                    if t >= "15:45":
                        hold = (b - ask) * 100 * n - 0.7 * n
                        break
                if hold is not None:
                    row[c]["hold"] = hold                      # held to 15:45, no stop
                    row[c]["hold_stop"] = stop if stop is not None else hold
        if d in spy:
            sq = spy[d][1]
            ss = {t[11:]: spot(sq, t) for t in sorted({t for qs in sq.values() for t in qs if t[:10] == d})}
            so = ss.get("09:30") or ss.get("09:45")
            for c in CHECKS:
                if c in row and so and ss.get(c):
                    row[c]["spy_move"] = (ss[c] - so) / so * 100
        rows.append(row)
        prev_close = close
    json.dump(rows, open(OUT, "w"))
    return rows


def score(rows):
    years = [("2022", "2022-01-01", "2022-12-31"), ("2024-25", "2024-10-28", "2025-10-26"), ("2025-26", "2025-10-27", "2026-10-30")]
    def filt(name, f):
        print(f"\n{name}")
        for c in CHECKS:
            line = []
            for y, lo, hi in years:
                sel = [r for r in rows if lo <= r["date"] <= hi and c in r and "hold" in r[c] and f(r, r[c])]
                n = len(sel)
                cont = sum(1 for r in sel if (r["close"] - r[c]["px"]) * (1 if r[c]["move"] >= 0 else -1) / r[c]["px"] * 100 >= 0.3)
                h = sum(r[c]["hold"] for r in sel); hs = sum(r[c]["hold_stop"] for r in sel)
                line.append(f"{y}: {n:3}d, kept going {cont:3} ({100 * cont / max(1, n):3.0f}%), hold {h:+7.0f}, with stop {hs:+7.0f}")
            print(f"  at {c}: " + " | ".join(line))
    filt("Every day (baseline)", lambda r, x: True)
    for m in (0.5, 0.75, 1.0, 1.5):
        filt(f"QQQ moved {m}%+ since the open", lambda r, x, m=m: abs(x["move"]) >= m)
    filt("QQQ 1%+ and SPY 0.5%+ the same way", lambda r, x: abs(x["move"]) >= 1 and x.get("spy_move") is not None and x["spy_move"] * x["move"] > 0 and abs(x["spy_move"]) >= 0.5)
    filt("Gap and go: gapped 0.5%+ and moving the same way 0.5%+ since the open",
         lambda r, x: r["prev_close"] and abs((r["open"] - r["prev_close"]) / r["prev_close"] * 100) >= 0.5 and (r["open"] - r["prev_close"]) * x["move"] > 0 and abs(x["move"]) >= 0.5)
    filt("Opening-range break: price beyond the 9:30-10:00 range, 0.5%+ from the open",
         lambda r, x: abs(x["move"]) >= 0.5 and (x["px"] > r["orh"] if x["move"] > 0 else x["px"] < r["orl"]))
    med = statistics.median([r["10:30"]["straddle_pct"] for r in rows if "10:30" in r and r["10:30"].get("straddle_pct")])
    filt(f"Options pricing a big day (straddle above the median {med:.2f}%) and QQQ 0.75%+",
         lambda r, x: x.get("straddle_pct") and x["straddle_pct"] > med and abs(x["move"]) >= 0.75)


if __name__ == "__main__":
    rows = json.load(open(OUT)) if os.path.exists(OUT) and "--rebuild" not in sys.argv else build()
    print(f"{len(rows)} trading days")
    score(rows)
