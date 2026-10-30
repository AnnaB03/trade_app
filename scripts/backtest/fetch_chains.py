"""Download a year of weekly option chains (bid/ask every 15 minutes) from the
local Theta Terminal (ThetaData Options Value) for the spread backtests.

One file per symbol and weekly expiry: data/backtest/<SYM>_<YYYYMMDD>.json.gz,
holding the 7 calendar days before expiry. Re-running skips files already
saved, so an interrupted download resumes where it stopped.

    python3 scripts/backtest/fetch_chains.py QQQ SPY
"""
import gzip, json, os, sys, time, datetime as dt, urllib.request

BASE = "http://127.0.0.1:25503/v3"
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(ROOT, "data", "backtest")
START, END = dt.date(2025, 10, 27), dt.date(2026, 10, 29)


def get(path, timeout=600):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.load(r)["response"]


def weekly_expiries(sym):
    """The last expiry of each calendar week (Friday, or Thursday before a holiday)."""
    exps = sorted(dt.date.fromisoformat(x["expiration"]) for x in get(f"/option/list/expirations?symbol={sym}&format=json"))
    weeks = {}
    for e in exps:
        if START <= e <= END:
            weeks[e.isocalendar()[:2]] = e  # later dates in the week overwrite earlier ones
    return sorted(weeks.values())


def fetch(sym, exp):
    path = os.path.join(OUT, f"{sym}_{exp:%Y%m%d}.json.gz")
    if os.path.exists(path):
        return "cached"
    # A whole-chain request (strike=*) over a date range returns only one day,
    # so the chain is asked for one trading day at a time.
    merged = {}
    for back in range(7, -1, -1):
        day = exp - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        for c in get(f"/option/history/quote?symbol={sym}&expiration={exp:%Y%m%d}&strike=*&right=both"
                     f"&date={day:%Y%m%d}&interval=15m&format=json"):
            key = (c["contract"]["strike"], c["contract"]["right"][0])
            merged.setdefault(key, []).extend([b["timestamp"], b["bid"], b["ask"]] for b in c["data"] if b["bid"] > 0 or b["ask"] > 0)
    slim = [{"k": k, "r": r, "q": q} for (k, r), q in merged.items()]
    with gzip.open(path + ".tmp", "wt") as f:
        json.dump({"symbol": sym, "expiration": exp.isoformat(), "contracts": slim}, f)
    os.replace(path + ".tmp", path)
    return f"{len(slim)} contracts"


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for sym in sys.argv[1:] or ["QQQ", "SPY"]:
        exps = weekly_expiries(sym)
        for i, exp in enumerate(exps, 1):
            t = time.time()
            for attempt in range(3):
                try:
                    note = fetch(sym, exp)
                    break
                except Exception as e:
                    note = f"failed ({e}); retry {attempt + 1}"
                    time.sleep(10)
            print(f"{sym} {exp} [{i}/{len(exps)}] {note} {time.time() - t:.0f}s", flush=True)
