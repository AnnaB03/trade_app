#!/usr/bin/env python3
"""How the watch-only trades would have ended.

usage: shadow-report.py [YYYY-MM-DD]      (default: every recorded day)

Reads data/shadow.json (would-be entries recorded by autotrade for a playbook
that is not allowed to trade yet) and replays each one minute by minute against
real prices, applying the live exit rules for a same-day position:

  +7% at the bid          -> sold (quick_target)
  (no dollar cap: options have none since 2026-10-15; the 20% stop is the limit)
  stock through the idea's invalidation or target -> sold
  15:45 ET                -> sold (flat by the close)

This is an ESTIMATE, and it says so on every line. The entry is the real ask at
the moment of the would-be buy. After that the option is priced from its
one-minute TRADE prices less half the entry spread (a stand-in for the bid),
or, when the contract did not trade, from the stock's move times the delta.
A real fill could differ either way. Fees are included.
"""
import json
from zoneinfo import ZoneInfo
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEE = 0.35
# The per-trade loss limit is 1% of the account, read from the same place the
# app reads it. It was a fixed $100 here and scored a $25K account's trades
# against the $10K limit.
def account_size():
    try:
        for line in open(os.path.join(ROOT, ".env.local")):
            if line.startswith("ACCOUNT_SIZE="):
                return float(line.split("=", 1)[1].strip().strip('"').strip("'"))
    except Exception:
        pass
    return 10000.0


# The live exits since 2026-10-14: +50% profit take, 20% option stop, 2% max loss
# (exitRules.PROFIT_TAKE_PCT / HARD_LOSS_PCT, entryRules.RISK_PER_TRADE_PCT); also the
# idea's target and invalidation, and flat at 15:45.
TARGET_PCT, STOP_PCT, MAX_LOSS = 50.0, 20.0, account_size() * 0.02
# Since 2026-11-05 a blocked trade is scored the way a placed one would really
# be handled (bug fix): the +$80 quick sale at the bid (exitRules.PROFIT_TAKE_USD,
# since 10/27) and today's option size, 1% of the account at the 20% stop
# (entryRules.OPTION_RISK_PCT, since 11/02), at most 15% of the account in one
# position. Before, winners ran to +50% at the idea's own (2%) contract count:
# 11/05's blocked puts scored +$1,500 to +$3,200 each where the live rules
# would have sold them near +$80.
PROFIT_TAKE_USD, OPTION_RISK_PCT, POSITION_CAP_PCT = 80.0, 1.0, 15.0
# Let it run (entryRules.letItRun, since 2026-11-05): no +$80 sale when QQQ was
# 0.5%+ and SPY 0.25%+ our way since the open at the buy. The stop is judged at
# the mid, as live (QA, 2026-11-05: it was judged at the bid and fired early).
LET_RUN_QQQ_PCT, LET_RUN_SPY_PCT = 0.5, 0.25
_index_bars = {}


def let_run(day, start, put):
    moves = []
    for sym in ("QQQ", "SPY"):
        if (sym, day) not in _index_bars:
            _index_bars[(sym, day)] = bars(sym, day)
        b = _index_bars[(sym, day)]
        keys = sorted(b)
        upto = [k for k in keys if k <= start]
        if not keys or not upto:
            return False
        o, last = float(b[keys[0]]["open"]), float(b[upto[-1]]["close"])
        moves.append((last - o) / o * 100 * (-1 if put else 1))
    return moves[0] >= LET_RUN_QQQ_PCT and moves[1] >= LET_RUN_SPY_PCT


def live_contracts(ask, bid):
    spread = max(0.0, ask - (bid or ask))
    per = (ask * STOP_PCT / 100 + spread) * 100
    n = int(account_size() * OPTION_RISK_PCT / 100 // per) if per > 0 else 1
    cap = int(account_size() * POSITION_CAP_PCT / 100 // (ask * 100)) if ask > 0 else 1
    return max(1, min(n, max(1, cap)))


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
    # New York time with daylight saving (a fixed UTC-4 put every replay an hour late from 2026-11-01).
    at = datetime.fromisoformat(r["at"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
    day, start = at.strftime("%Y-%m-%d"), at.strftime("%H:%M")
    ask, bid = r.get("optionAsk"), r.get("optionBid")
    if not ask:
        return day, start, None, "no entry price recorded", None
    half = max(0.0, (ask - (bid or ask)) / 2)
    n = live_contracts(ask, bid)
    delta = abs(r.get("delta") or 0.5)
    put = r["action"] == "PUT"
    ob, ub = bars(r["occ"], day), bars(r["symbol"], day)
    if not ub:
        return day, start, None, "no price history yet", None
    u0 = r.get("underlying") or next((ub[k]["close"] for k in sorted(ub) if k >= start), None)
    run = let_run(day, start, put)
    last_opt, t = None, at.replace(second=0, microsecond=0)
    end = t.replace(hour=15, minute=45)
    now = datetime.now(t.tzinfo)
    last_pnl = None
    while True:
        t += timedelta(minutes=1)
        # Never replay past the present: a trade recorded this morning is still
        # open, not "flat by the close".
        if t > now:
            return day, start, last_pnl, "STILL OPEN (so far)", now.strftime("%H:%M")
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
        last_pnl = pnl
        why = None
        if pnl > PROFIT_TAKE_USD and not run:
            why = "take_profit_usd"
        elif est_bid >= ask * (1 + TARGET_PCT / 100):
            why = "take_profit"
        elif est_bid + half <= ask * (1 - STOP_PCT / 100):
            why = "stop"
        # No dollar cap on options since 2026-10-15 (exitRules): the 20% stop above
        # is their loss limit. Every shadow row is an option, so MAX_LOSS no longer applies.
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
print("RECORDED, NOT PLACED (watch-only, or blocked by a rule) — estimated outcomes")
for r in rows:
    # filter by the New York date before replaying: replaying every row first took minutes
    if want and datetime.fromisoformat(r["at"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d") != want:
        continue
    day, start, pnl, why, when = replay(r)
    label = f"blocked: {r['blockedBy']}" if r.get("blockedBy") else (r.get("playbook") or "")
    head = f"  {day} {start}  {r['symbol']:5} {r['action']:4} x{live_contracts(r['optionAsk'], r.get('optionBid')) if r.get('optionAsk') else 1} {r.get('occ') or '':22} in @{r.get('optionAsk')}  [{label}]"
    if pnl is None:
        print(f"{head}  -> {why}")
        continue
    if why.startswith("STILL OPEN"):
        print(f"{head}  -> still open at {when}, about {pnl:+,.0f} so far")
        continue
    n += 1
    tot += pnl
    wins += pnl > 0
    print(f"{head}  -> {why} at {when}, about {pnl:+,.0f}")
if n:
    print(f"  {n} finished trades, {wins} won, estimated total {tot:+,.0f}")
else:
    print("  none recorded" + (f" for {want}" if want else ""))
