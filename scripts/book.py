#!/usr/bin/env python3
"""The paper book: one account, one price per position.

usage: book.py AUTOEXIT.json AUTOTRADE.json JOURNAL.json

Prints closes/opens from the two route responses, then the book.

Pricing rules:
  - one feed, the real-time one. There is no second, slower feed to compare with,
    because a real account will not have one;
  - a position is worth its BID: what selling it now would realise;
  - entryFillPrice null = a working order, not a position;
  - realized P&L is net of the per-contract option fee;
  - cash follows a cash account: today's sale proceeds cannot buy until tomorrow.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime

BASE = os.environ.get("COCKPIT_BASE", "http://localhost:3000")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(p):
    try:
        return json.load(open(p))
    except Exception as e:
        return {"error": f"unreadable {p}: {e}"}


def get(path):
    return json.load(urllib.request.urlopen(f"{BASE}{path}", timeout=30))


def quote(sym):
    d = get(f"/api/quote?symbols={urllib.parse.quote(sym)}")["quotes"]
    return (d if isinstance(d, list) else [d])[0]


ax, at, jr = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
entries = jr.get("entries") or []
base = load(os.path.join(ROOT, "data", "baseline.json"))
fs = base.get("freshStartAt")
fs_ms = datetime.fromisoformat(fs.replace("Z", "+00:00")).timestamp() * 1000 if fs else 0
account = base.get("accountSize") or ax.get("accountSize") or 10000


def counted(r):
    if r.get("legacy") is True:
        return False
    c = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp() * 1000
    return not fs_ms or c >= fs_ms


for n, d in (("autoexit", ax), ("autotrade", at)):
    if "error" in d:
        print(f"ERROR KEY in {n}: {d['error']}")
print(f"autoexit closed {ax.get('closed')} of {ax.get('checked')} | autotrade placed {at.get('placed')} of {at.get('candidateCount')}"
      f" | account ${account:,.0f}, end-of-day bar ${ax.get('eodBarUsd')}")
for r in ax.get("results") or []:
    if r.get("closed"):
        print(f"  CLOSED {r.get('symbol')} {r.get('tag')} {(r.get('detail') or '')[:90]} @{r.get('exitPrice')}")
    elif r.get("error"):
        print(f"  EXIT NOT DONE {r.get('symbol')} {r.get('tag')}: {r['error'][:110]}")
for o in at.get("results") or []:
    if isinstance(o, dict) and o.get("placed"):
        # A resting limit is an order, not a position: say which this is.
        label = "ORDER PLACED (resting, not filled)" if o.get("working") else "OPENED"
        print(f"  {label} " + json.dumps({k: v for k, v in o.items() if k != "order"}))

live = [r for r in entries if r.get("status") == "open" and counted(r)]
print(f"\nBOOK (since {fs or 'no baseline'}):")
tot = dep = 0
if not live:
    print("  no open positions")
for r in live:
    filled = r.get("entryFillPrice") is not None
    ent = r.get("entryFillPrice") or r.get("entryLimitPrice")
    n = r.get("entryFilledQuantity") or r.get("entryQuantity")
    key = r.get("occ") or r["symbol"]
    mult = 100 if r.get("vehicle") == "OPTION" else 1
    q = quote(key)
    bid = q.get("bid") or q.get("last") or 0
    if not filled:
        mins = (datetime.now().timestamp() * 1000 - datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp() * 1000) / 60000
        print(f"  {key:22} {n:>3} @ {ent:<7} WORKING ORDER, not a position (resting {mins:.0f} min; market {q.get('bid')}/{q.get('ask')})")
        dep += ent * n * mult
        continue
    g = (bid - ent) * n * mult
    tot += g
    dep += ent * n * mult
    print(f"  {key:22} {n:>3} @ {ent:<7} bid {bid:<8} {g:>+7.0f} ({(bid - ent) / ent * 100:>+5.1f}%)")
done = [r for r in entries if r.get("status") == "closed" and isinstance(r.get("pnl"), (int, float))
        and not r.get("excludeFromGoal") and counted(r)]
real = sum(r["pnl"] for r in done)
print(f"  open P&L {tot:+,.0f} at the bid | in positions and working orders ${dep:,.0f} of ${account:,.0f} ({dep / account * 100:.0f}%)")
print(f"  REALIZED, net of fees: {real:+,.0f} across {len(done)} closes ({real / account * 100:+.2f}% of the account)")
try:
    a = get("/api/account")
    if a.get("available") is not None:
        print(f"  CASH: ${a['available']:,.0f} can buy today | ${a['unsettled']:,.0f} from today's sales settles tomorrow | fees paid ${a.get('feesPaid') or 0:,.2f}")
except Exception as e:
    print(f"  CASH unreadable: {e}")
