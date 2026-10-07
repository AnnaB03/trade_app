#!/usr/bin/env python3
"""The paper book, split into the $10K ledger and legacy positions.

usage: book.py AUTOEXIT.json AUTOTRADE.json JOURNAL.json

Prints closes/opens from the two route responses, then the book:
  * the $10K ledger — positions opened after the baseline in data/baseline.json
    (capital deployed is measured against the account size, realized P&L starts
    at zero on the baseline);
  * LEGACY positions — open when the ledger started; still managed, never counted.

Pricing rules (each one learned from a wrong number):
  - sandbox feed, never production, for what a position is worth; options at the
    MID of the sandbox quote, shares at the sandbox last;
  - entryFillPrice null = an unfilled order, not a position;
  - frozen comes from the journal row's own flag, never a ticker match;
  - production is shown alongside because it LEADS the fill feed by ~15 min.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("COCKPIT_BASE", "http://localhost:3000")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(p):
    try:
        return json.load(open(p))
    except Exception as e:
        return {"error": f"unreadable {p}: {e}"}


def quote(sym, delayed=True):
    u = f"{BASE}/api/quote?symbols={urllib.parse.quote(sym)}" + ("&delayed=true" if delayed else "")
    d = json.load(urllib.request.urlopen(u, timeout=30))["quotes"]
    return (d if isinstance(d, list) else [d])[0]


ax, at, jr = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
entries = jr.get("entries") or []
base = load(os.path.join(ROOT, "data", "baseline.json"))
from datetime import datetime
fs = base.get("freshStartAt")
fs_ms = datetime.fromisoformat(fs.replace("Z", "+00:00")).timestamp() * 1000 if fs else 0
account = base.get("accountSize") or ax.get("accountSize") or 10000


def legacy(r):
    if r.get("legacy") is True:
        return True
    if not fs_ms:
        return False
    c = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp() * 1000
    return c < fs_ms


for n, d in (("autoexit", ax), ("autotrade", at)):
    if "error" in d:
        print(f"ERROR KEY in {n}: {d['error']}")
print(f"autoexit closed {ax.get('closed')} of {ax.get('checked')} | autotrade placed {at.get('placed')} of {at.get('candidateCount')}"
      f" | account ${account:,.0f}, end-of-day bar ${ax.get('eodBarUsd')}")
for r in ax.get("results") or []:
    if r.get("closed"):
        print(f"  CLOSED {r.get('symbol')} {r.get('tag')} {(r.get('detail') or '')[:90]} @{r.get('exitPrice')}")
for o in at.get("results") or []:
    if isinstance(o, dict) and o.get("placed"):
        print("  OPENED " + json.dumps({k: v for k, v in o.items() if k != "order"}))


def cost(r):
    return (r.get("entryFillPrice") or r.get("entryLimitPrice") or 0) * (r.get("entryFilledQuantity") or r.get("entryQuantity") or 0) * (100 if r.get("vehicle") == "OPTION" else 1)


def line(r):
    ent = r.get("entryFillPrice") or r.get("entryLimitPrice")
    n = r.get("entryFilledQuantity") or r.get("entryQuantity")
    key = r.get("occ") or r["symbol"]
    s = quote(key)
    if r.get("vehicle") == "OPTION":
        m = (s["bid"] + s["ask"]) / 2
        p = quote(key, False)
        pm = (p["bid"] + p["ask"]) / 2
        g = (m - ent) * n * 100
        gap = f"  | prod {p['bid']}/{p['ask']} ({(pm - m) / m * 100:+.0f}%)" if m else ""
        flag = "  <-- sandbox stale/gapped" if m and abs(pm - m) / m > 0.10 else ""
    else:
        m = s["last"]
        g = (m - ent) * n
        gap, flag = "", ""
    tags = ("  (UNFILLED)" if r.get("entryFillPrice") is None else "") + ("  FROZEN" if r.get("frozen") else "")
    if r.get("realisticEntry") and r.get("vehicle") == "OPTION":
        # The sandbox filled this entry at a stale price far from the real market.
        # Show what it is worth against the price that would really have been paid.
        # Both ends on the REAL clock: production's mid now against the price that
        # would actually have been paid. Using the sandbox mark here mixed clocks and
        # printed -302 for a position that was really about -40.
        real = (pm - r["realisticEntry"]) * n * 100
        tags += f"  | REAL {real:+,.0f} (production mid {pm:.2f} vs realistic entry {r['realisticEntry']})"
    pct = (m - ent) / ent * 100 if ent else 0
    return key, n, ent, m, g, pct, tags + gap + flag


live = [r for r in entries if r.get("status") == "open"]
new = [r for r in live if not legacy(r)]
old = [r for r in live if legacy(r)]

print(f"\n$10K LEDGER (from {fs or 'no baseline'}):")
tot = clo = dep = 0
if not new:
    print("  no open positions")
for r in new:
    key, n, ent, m, g, pct, tags = line(r)
    filled = r.get("entryFillPrice") is not None
    dep += 0 if r.get("frozen") else cost(r)
    if filled:
        tot += g
        clo += 0 if r.get("frozen") else g
    print(f"  {key:22} {n:>3} @ {ent:<6} mark {m:<8.3f} {g:>+7.0f} ({pct:>+5.1f}%){tags}")
closed_new = [r for r in entries if r.get("status") == "closed" and isinstance(r.get("pnl"), (int, float))
              and not r.get("excludeFromGoal") and not legacy(r)]
real = sum(r["pnl"] for r in closed_new)
print(f"  open P&L {tot:+,.0f} | closeable {clo:+,.0f} | deployed ${dep:,.0f} of ${account:,.0f} ({dep / account * 100:.0f}%)")
print(f"  REALIZED since the fresh start: {real:+,.0f} across {len(closed_new)} closes ({real / account * 100:+.2f}% of the account)")

if old:
    print("\nLEGACY — open before the ledger started, managed but NOT counted:")
    lt = 0
    for r in old:
        key, n, ent, m, g, pct, tags = line(r)
        lt += g
        print(f"  {key:22} {n:>3} @ {ent:<6} mark {m:<8.3f} {g:>+7.0f} ({pct:>+5.1f}%){tags}")
    print(f"  legacy open P&L {lt:+,.0f}")
