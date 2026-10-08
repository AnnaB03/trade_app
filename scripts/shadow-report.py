#!/usr/bin/env python3
"""How the watch-only trades would have ended.

usage: shadow-report.py [YYYY-MM-DD]      (default: every recorded day)

Reads data/shadow.json (would-be entries recorded by autotrade for a playbook
that is not allowed to trade yet) and replays each one minute by minute against
real prices, applying the live exit rules for a same-day position:

  +7% at the bid          -> sold (quick_target)
  down $100 at the bid    -> sold (max_loss)
  stock through the idea's invalidation or target -> sold
  15:45 ET                -> sold (flat by the close)

This is an ESTIMATE, and it says so on every line. The entry is the real ask at
the moment of the would-be buy. After that the option is priced from its
one-minute TRADE prices less half the entry spread (a stand-in for the bid),
or, when the contract did not trade, from the stock's move times the delta.
A real fill could differ either way. Fees are included.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEE = 0.35
TARGET_PCT, MAX_LOSS = 7.0, 100.0


def token():
    for line in open(os.path.join(ROOT, ".env.local")):
        if line.startswith("TRADIER_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no TRADIER_TOKEN in .env.local")


TOK = token()


def bars(sym, day):
    q = urllib.parse.urlencode({"symbol": sym, "interval": "1min", "start": f"{day} 09:30", "end": f"{day} 16:00"})
    req = urllib.request.Request(f"https://api.tradier.com/v1/markets/timesales?{q}",
                                 headers={"Authorization": f"Bearer {TOK}", "Accept": "application/json"})
    try:
        d = (json.load(urllib.request.urlopen(req, timeout=40)).get("series") or {}).get("data") or []
    except Exception:
        return {}
    d = [d] if isinstance(d, dict) else d
    return {b["time"][11:16]: b for b in d}


def replay(r):
    at = datetime.fromisoformat(r["at"].replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=-4)))
    day, start = at.strftime("%Y-%m-%d"), at.strftime("%H:%M")
    ask, bid = r.get("optionAsk"), r.get("optionBid")
    if not ask:
        return day, start, None, "no entry price recorded", None
    half = max(0.0, (ask - (bid or ask)) / 2)
    n = r.get("contracts") or 1
    delta = abs(r.get("delta") or 0.5)
    put = r["action"] == "PUT"
    ob, ub = bars(r["occ"], day), bars(r["symbol"], day)
    if not ub:
        return day, start, None, "no price history yet", None
    u0 = r.get("underlying") or next((ub[k]["close"] for k in sorted(ub) if k >= start), None)
    last_opt, t = None, at.replace(second=0, microsecond=0)
    end = t.replace(hour=15, minute=45)
    while True:
        t += timedelta(minutes=1)
        k = t.strftime("%H:%M")
        u = ub.get(k)
        if k in ob:
            last_opt = ob[k]["close"]
        if u is None and t < end:
            continue
        ustock = u["close"] if u else None
        if last_opt is not None:
            est_bid = max(0.01, last_opt - half)
        elif ustock is not None and u0:
            est_bid = max(0.01, (bid or ask) + delta * (u0 - ustock if put else ustock - u0))
        else:
            est_bid = bid or ask
        pnl = (est_bid - ask) * 100 * n - 2 * FEE * n
        why = None
        if est_bid >= ask * (1 + TARGET_PCT / 100):
            why = "quick_target"
        elif (est_bid - ask) * 100 * n <= -MAX_LOSS:
            why = "max_loss"
        elif ustock is not None and r.get("invalidation") is not None and (ustock >= r["invalidation"] if put else ustock <= r["invalidation"]):
            why = "invalidation"
        elif ustock is not None and r.get("target") is not None and (ustock <= r["target"] if put else ustock >= r["target"]):
            why = "target"
        elif t >= end:
            why = "flat by the close"
        if why:
            return day, start, pnl, why, k


rows = json.load(open(os.path.join(ROOT, "data", "shadow.json"))) if os.path.exists(os.path.join(ROOT, "data", "shadow.json")) else []
want = sys.argv[1] if len(sys.argv) > 1 else None
tot = wins = n = 0
print("WATCH-ONLY trades (recorded, never placed) — estimated outcomes")
for r in rows:
    day, start, pnl, why, when = replay(r)
    if want and day != want:
        continue
    head = f"  {day} {start}  {r['symbol']:5} {r['action']:4} x{r.get('contracts') or 1} {r.get('occ') or '':22} in @{r.get('optionAsk')}"
    if pnl is None:
        print(f"{head}  -> {why}")
        continue
    n += 1
    tot += pnl
    wins += pnl > 0
    print(f"{head}  -> {why} at {when}, about {pnl:+,.0f}")
if n:
    print(f"  {n} trades, {wins} won, estimated total {tot:+,.0f}")
else:
    print("  none recorded" + (f" for {want}" if want else ""))
