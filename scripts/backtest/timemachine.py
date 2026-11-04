"""Time Machine: how often does a plan hit its target first, its stop first,
or neither by 15:45? (owner, 2026-11-04: "lets build our own time machine").

Two answers for every plan, from the stock's own 5-minute bars (Tradier,
cached in data/backtest/bars/ so the history grows each day):
  - REPLAYS: the rest of the day rebuilt N times. Each bar after the buy is a
    real bar from a past session at the same time of day (+-2 bars), scaled
    to the running price, so it keeps the stock's own size of moves and the
    shape of the day (quiet lunch, busy close). Bars are drawn independently,
    so a replay does not know about trend days: read it as "a normal day".
  - HISTORY: the same plan (same % stop and target, bought at the same time)
    run on every past session's real bars. That is what really happened.
A bar that reaches both the stop and the target counts as the stop. A bar
that opens through the stop fills at its open (a gap is worse than -1R).

    python3 scripts/backtest/timemachine.py plan AMZN --entry 268.45 --stop 265.77 --target 271.13 --at 11:30
    python3 scripts/backtest/timemachine.py plan TSLA --entry 388 --stop 392 --target 380 --at 13:00 --side short
    python3 scripts/backtest/timemachine.py journal [2026-11-04]      # every trade bought that day, odds vs what happened
    python3 scripts/backtest/timemachine.py rule --target-pct 1 --stop-pct 1 --at 11:00 [--dip] [SYM ...]

Options are judged on the stock's own levels (the idea's target and
invalidation), not on the option's exits (+$80, 20% stop).
"""
import argparse, json, os, random, re, sqlite3, statistics, urllib.parse, urllib.request, datetime as dt
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
BARS = os.path.join(ROOT, "data", "backtest", "bars")
ET = ZoneInfo("America/New_York")
SLOTS = 78                                                   # 9:30 to 15:55, five minutes each
CORE = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "MU", "INTC", "QCOM", "ORCL", "AMZN", "GOOGL",
        "PLTR", "HOOD", "SPCX", "RKLB", "SMCI", "OKLO"]
TOK = next((l.split("=", 1)[1].strip().strip('"') for l in open(os.path.join(ROOT, ".env.local")) if l.startswith("TRADIER_TOKEN=")), None)


def slot(hhmm):
    h, m = map(int, hhmm.split(":"))
    return (h * 60 + m - 570) // 5


def tradier(sym, start, end):
    q = urllib.parse.urlencode({"symbol": sym, "interval": "5min", "start": f"{start} 09:30", "end": f"{end} 16:00", "session_filter": "open"})
    req = urllib.request.Request("https://api.tradier.com/v1/markets/timesales?" + q, headers={"Authorization": "Bearer " + TOK, "Accept": "application/json"})
    try:
        body = urllib.request.urlopen(req, timeout=60).read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode()
    if not body.startswith("{"):
        m = re.search(r"on or after (\d{4}-\d{2}-\d{2})", body)
        if m and m.group(1) > start:
            return tradier(sym, m.group(1), end)                # Tradier keeps about 40 sessions of 5-minute bars
        raise RuntimeError(f"{sym}: {body[:120]}")
    d = (json.loads(body).get("series") or {}).get("data") or []
    return [d] if isinstance(d, dict) else d


def sessions(sym, upto=None):
    """{date: [(o,h,l,c) x 78]} for full sessions, from the cache plus whatever is new."""
    os.makedirs(BARS, exist_ok=True)
    path = os.path.join(BARS, f"{sym}_5min.json")
    cache = json.load(open(path)) if os.path.exists(path) else {}
    today = dt.datetime.now(ET).date()
    start = max(cache) if cache else (today - dt.timedelta(days=90)).isoformat()
    if not cache or start < today.isoformat() or len(cache.get(start, [])) < SLOTS:
        by_day = {}
        for b in tradier(sym, start, today.isoformat()):
            by_day.setdefault(b["time"][:10], {})[slot(b["time"][11:16])] = [float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"])]
        for d, bars in by_day.items():
            if len(bars) == SLOTS and all(i in bars for i in range(SLOTS)):
                cache[d] = [bars[i] for i in range(SLOTS)]
            elif d == today.isoformat():
                cache.pop(d, None)                              # today, still forming: kept out of the pool
        json.dump(cache, open(path, "w"))
    return {d: v for d, v in sorted(cache.items()) if upto is None or d < upto}


def walk(bars, entry, stop, target, long, until):
    """bars: [(o,h,l,c)] after the buy. Returns (outcome, exit price)."""
    for o, h, l, c in bars[:until]:
        if long:
            if o <= stop: return "stop", o
            if l <= stop: return "stop", stop
            if o >= target or h >= target: return "target", max(o, target)
        else:
            if o >= stop: return "stop", o
            if h >= stop: return "stop", stop
            if o <= target or l <= target: return "target", min(o, target)
    return "open", bars[min(until, len(bars)) - 1][3] if bars else entry


def run(sym, entry, stop, target, at, until="15:45", day=None, n=10000, seed=7, window=2, dip=False):
    long = target > entry
    risk = abs(entry - stop)
    if risk <= 0 or (long and stop >= entry) or (not long and stop <= entry):
        raise ValueError("the stop must be on the other side of the entry from the target")
    pool = sessions(sym, upto=day)
    if len(pool) < 10:
        raise RuntimeError(f"{sym}: only {len(pool)} full sessions")
    first, last = slot(at) + 1, slot(until)                     # bars that start after the buy and end by `until`
    nbars = max(0, last - first)
    # each past bar as a ratio to the bar before it, by time of day
    ratios = {s: [] for s in range(1, SLOTS)}
    for bars in pool.values():
        for s in range(1, SLOTS):
            pc = bars[s - 1][3]
            ratios[s].append(tuple(x / pc for x in bars[s]))
    rng = random.Random(seed)
    tally = {"target": 0, "stop": 0, "open": 0}; rs = []; closes = []
    for _ in range(n):
        p, path = entry, []
        for s in range(first, first + nbars):
            o, h, l, c = rng.choice(ratios[min(SLOTS - 1, max(1, s + rng.randint(-window, window)))])
            path.append((p * o, p * h, p * l, p * c)); p *= c
        out, px = walk(path, entry, stop, target, long, nbars)
        tally[out] += 1; closes.append(p)
        rs.append(((px - entry) if long else (entry - px)) / risk)
    # history: the same % plan bought at `at` on every past session
    sp, tp = (stop - entry) / entry, (target - entry) / entry
    hist = {"target": 0, "stop": 0, "open": 0}; hrs = []; fired = 0
    days = list(pool)
    for i, d in enumerate(days):
        bars = pool[d]
        e = bars[first - 1][3]
        if dip:                                                 # the dip rule: up on the day, 1% under the day's high
            if i == 0: continue
            prev = pool[days[i - 1]][-1][3]
            hi = max(b[1] for b in bars[:first])
            if not (e > prev and e <= hi * 0.99): continue
        fired += 1
        out, px = walk(bars[first:], e, e * (1 + sp), e * (1 + tp), long, nbars)
        hist[out] += 1; hrs.append(((px - e) if long else (e - px)) / (e * abs(sp)))
    reward = abs(target - entry) / risk
    return {"symbol": sym, "side": "long" if long else "short", "entry": entry, "stop": stop, "target": target, "at": at, "until": until,
            "sessions": len(pool), "from": days[0], "to": days[-1], "replays": n, "reward_r": round(reward, 2),
            "mc": {k: round(v / n * 100, 1) for k, v in tally.items()}, "mc_avg_r": round(statistics.mean(rs), 3),
            "mc_close_pct": [round((statistics.quantiles(closes, n=20)[i] - entry) / entry * 100, 2) for i in (0, 9, 18)],
            "history": hist, "history_n": fired, "history_avg_r": round(statistics.mean(hrs), 3) if hrs else None,
            "break_even_pct": round(100 / (1 + reward), 1)}


def verdict(r):
    hit = r["mc"]["target"] + r["mc"]["stop"]
    if hit < 1: return "Rarely reaches either level by the close; it is a bet on where the close lands."
    edge = r["mc"]["target"] / hit * 100 - r["break_even_pct"]
    side = "the target" if edge > 0 else "the stop"
    a = abs(edge)
    if a < 5: return f"A coin flip: of the replays that reached a level, {r['mc']['target'] / hit * 100:.0f}% hit the target first, against {r['break_even_pct']:.0f}% needed to break even."
    return f"{'Strongly toward' if a >= 15 else 'Leans toward'} {side}: {r['mc']['target'] / hit * 100:.0f}% target-first of the replays that reached a level, against {r['break_even_pct']:.0f}% needed."


def show(r):
    h, hn = r["history"], max(1, r["history_n"])
    print(f"{r['symbol']} {r['side']} at {r['at']}: buy {r['entry']}, stop {r['stop']}, target {r['target']} ({r['reward_r']}R), until {r['until']}")
    print(f"  replays ({r['replays']:,} from {r['sessions']} sessions {r['from']}..{r['to']}): target first {r['mc']['target']}%, stop first {r['mc']['stop']}%, "
          f"neither {r['mc']['open']}%; average {r['mc_avg_r']:+.2f}R; close vs buy (5th/50th/95th) {r['mc_close_pct'][0]:+.2f}% / {r['mc_close_pct'][1]:+.2f}% / {r['mc_close_pct'][2]:+.2f}%")
    print(f"  history ({r['history_n']} real sessions, same plan): target {h['target']} ({h['target'] / hn * 100:.0f}%), stop {h['stop']} ({h['stop'] / hn * 100:.0f}%), "
          f"neither {h['open']}; average {r['history_avg_r']:+.2f}R" if r["history_avg_r"] is not None else "  history: no sessions")
    print("  " + verdict(r))


def journal(day):
    rows = [json.loads(x[0]) for x in sqlite3.connect(os.path.join(ROOT, "data", "cockpit.db")).execute("select data from journal")]
    et = lambda iso: dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET)
    todays = sorted([r for r in rows if r.get("entryFillPrice") and r.get("entryAt") and et(r["entryAt"]).date().isoformat() == day
                     and r.get("exitReasonTag") not in ("unfilled", "orphaned")], key=lambda r: r["entryAt"])
    out = []
    print(f"{day}: {len(todays)} trades bought")
    print("sym   kind    bought  plan (stock levels)            replays: target/stop/neither  history: t/s/n   avg R   | what happened")
    for r in todays:
        opt = r.get("vehicle") == "OPTION"
        entry = r.get("entryUnderlying") if opt else r["entryFillPrice"]
        tgt, inv = r.get("target"), r.get("invalidation")
        at = et(r["entryAt"]).strftime("%H:%M")
        if not (entry and tgt and inv) or at >= "15:40":
            print(f"{r['symbol']:5} {'option' if opt else 'shares':7} {at}   no stock-level plan on the row"); continue
        if opt and r.get("optionType") == "put" and tgt > entry: tgt, inv = inv, tgt
        try:
            v = run(r["symbol"], float(entry), float(inv), float(tgt), at, day=day, n=4000)
        except (ValueError, RuntimeError) as e:
            print(f"{r['symbol']:5} {at}   skipped: {e}"); continue
        h, hn = v["history"], max(1, v["history_n"])
        pnl = r.get("pnl")
        print(f"{r['symbol']:5} {'option' if opt else 'shares':7} {at}   {entry:>8.2f} stop {inv:>8.2f} tgt {tgt:>8.2f}  "
              f"{v['mc']['target']:5.1f}/{v['mc']['stop']:5.1f}/{v['mc']['open']:5.1f}      {h['target'] / hn * 100:3.0f}/{h['stop'] / hn * 100:3.0f}/{h['open'] / hn * 100:3.0f}   {v['mc_avg_r']:+.2f}  "
              f"| {r.get('exitReasonTag') or 'open'} {pnl if isinstance(pnl, (int, float)) else 0:+.0f}")
        out.append((v, r))
    if out:
        exp_t = sum(v["mc"]["target"] for v, _ in out) / 100
        got_t = sum(1 for _, r in out if (r.get("exitReasonTag") or "").startswith(("target", "take_profit")))
        print(f"\nThe replays expected about {exp_t:.1f} of {len(out)} to reach the target first; {got_t} sold at a target or profit-take.")
        print(f"Average expected R across the day's plans: {statistics.mean(v['mc_avg_r'] for v, _ in out):+.2f}R (above 0 means the plans had an edge on a normal day).")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("symbol"); p.add_argument("--entry", type=float, required=True); p.add_argument("--stop", type=float, required=True)
    p.add_argument("--target", type=float, required=True); p.add_argument("--at", required=True); p.add_argument("--until", default="15:45"); p.add_argument("--date")
    p.add_argument("--replays", type=int, default=10000); p.add_argument("--seed", type=int, default=7); p.add_argument("--side", choices=("long", "short"))
    j = sub.add_parser("journal"); j.add_argument("date", nargs="?", default=dt.datetime.now(ET).date().isoformat())
    u = sub.add_parser("rule"); u.add_argument("symbols", nargs="*"); u.add_argument("--target-pct", type=float, default=1); u.add_argument("--stop-pct", type=float, default=1)
    u.add_argument("--at", default="11:00"); u.add_argument("--until", default="15:45"); u.add_argument("--short", action="store_true"); u.add_argument("--dip", action="store_true")
    u.add_argument("--replays", type=int, default=4000)
    a = ap.parse_args()
    if a.cmd == "plan":
        if a.side and (a.side == "long") != (a.target > a.entry):
            raise SystemExit("--side does not match the target's direction")
        show(run(a.symbol.upper(), a.entry, a.stop, a.target, a.at, a.until, a.date, a.replays, a.seed))
    elif a.cmd == "journal":
        journal(a.date)
    else:
        sgn = -1 if a.short else 1
        print(f"Rule: {'short' if a.short else 'long'} at {a.at}, target {a.target_pct}%, stop {a.stop_pct}%, until {a.until}"
              f"{'; history only on dip days (up on the day, 1% under the high)' if a.dip else ''}")
        print("sym    replays: target/stop/neither   avg R | history: n  target/stop/neither  avg R")
        allr = []
        for s in (a.symbols or CORE):
            try:
                v = run(s.upper(), 100.0, 100 * (1 - sgn * a.stop_pct / 100), 100 * (1 + sgn * a.target_pct / 100), a.at, a.until, n=a.replays, dip=a.dip)
            except RuntimeError as e:
                print(f"{s:6} skipped: {e}"); continue
            h, hn = v["history"], max(1, v["history_n"])
            print(f"{s:6} {v['mc']['target']:5.1f}/{v['mc']['stop']:5.1f}/{v['mc']['open']:5.1f}          {v['mc_avg_r']:+.2f} | {v['history_n']:3}  "
                  f"{h['target'] / hn * 100:3.0f}/{h['stop'] / hn * 100:3.0f}/{h['open'] / hn * 100:3.0f}         {v['history_avg_r'] if v['history_avg_r'] is not None else 0:+.2f}")
            allr.append(v)
        if allr:
            hn = sum(v["history_n"] for v in allr)
            print(f"\nAll: replays {statistics.mean(v['mc_avg_r'] for v in allr):+.3f}R a trade; history {sum((v['history_avg_r'] or 0) * v['history_n'] for v in allr) / max(1, hn):+.3f}R over {hn} real sessions")


if __name__ == "__main__":
    main()
