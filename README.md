# Options Cockpit

A personal options-trading desk: live quotes and chains (Tradier), a
defined-risk position builder with hard safety gates, AI-generated trade
ideas that carry a real plan (entry trigger, stop, target, conviction) and
grade themselves against what actually happened, and a trade journal.

Paper trading only. Orders go to a **simulated cash account**
(`app/api/simBroker.js`) that fills at the real-time bid and ask, charges a
per-contract option fee, and lets only settled cash buy — the rules of the
real Tradier cash account this is practice for. There is one price feed, the
real-time one; nothing is filled or valued off a delayed feed. `BROKER=sandbox`
sends orders to the Tradier sandbox instead, as a plumbing check only: its
fills lag the quotes by ~15 minutes, so its P&L means nothing.

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in your keys
npm run dev
```

See `.env.local.example` for what each key unlocks and what the app does
without it (most features degrade gracefully rather than break).

## Tabs

- **Watchlist** — live quotes, RVOL, and a per-symbol reality check (is the
  volume real, does the news justify the move, where do halt bands sit).
- **Chain & Risk** — option chain, expected move, IV vs. realized vol, OI
  walls, and a spread builder with hard risk gates (no naked short calls,
  a per-trade max-loss cap, a liquidity check on wide markets).
- **Track Record** — every AI idea ever suggested, auto-graded at +1 hour,
  +1 day, and at expiration, with hit-rate calibration by catalyst, symbol,
  and market regime.
- **Journal** — your own manual trade log, separate from the AI ledger above.
- **Ideas** — AI-generated trade plans (Claude), fed the market regime, the
  calendar, option flow, and the app's own track record so far. A resolved
  option idea can be staged straight into the sandbox order gates.
  Ideas are sized for the account size set in the tab header (default
  $1,000, or `ACCOUNT_SIZE`): cheaper liquid names are scanned in, an option
  contract must cost under 10% of the account to be suggested at all, and
  share counts come from a 1%-risk-to-the-stop rule capped at 25% per
  position. On a small account most expensive names resolve to shares or WAIT
  by design.

- **Sweeps** — a liquidity-sweep ("stop-hunt") detector, run as two separate
  strategies so they can be compared: **limit** (a resting buy just under an
  unswept daily swing low, where stops cluster, stop 1 ATR lower) and
  **reclaim** (price trades under that low, then closes back above it; buy,
  stop under the sweep low). Daily and intraday (5-min) reclaims are both
  detected. Each symbol also gets its own ~2-year daily backtest and a 0–100
  fit score, so the list can be judged by evidence. Setups are logged to the
  same ledger as AI ideas and graded the same way. A resting limit counts only
  once price actually reaches it, so its fill rate is measured too. A paper
  **autopilot** (toggle in the tab, every 5 min during regular hours while
  the app is open) buys them through the same order path as the AI
  autotrade. A comparison table puts AI ideas and both sweep variants side
  by side. Live sweep setups also appear on the Ideas tab in their own
  section, with the same "send to paper" button. That section is display
  only: Claude never sees the sweep setups, so the comparison stays fair. Engine: `app/lib/sweep.js`; routes: `/api/sweeps`,
  `/api/sweeps/autotrade` (`?dryRun=true`), `/api/sweeps/compare`.

Both paper autopilots trade every qualifying suggestion, expensive ones
included: options over the account's affordability cap and share positions
over the 25% cap are placed anyway (paper money), with the sizing figure
still shown. Add `?allowUnaffordable=false` to either autotrade route to
put the cap back.

Autopilot trades now close themselves out in the Journal. Fills, bracket
stop-outs, and entry limits that expired unfilled are read back from the
paper broker (`app/api/journalReconcile.js`).

## The daily plan

Written the way a trader sets rules before the open, in R — one R is the
most one trade may lose, 1% of the account ($100 on $10K). Every rule stops
new entries only; open positions are still managed, and the automatic
rules clear at the next session. Engine: `app/api/riskLib.js`; the
Journal tab's account card shows the plan and where today stands.

- **Loss limit** — down 5% realized today: done for the day.
- **Losing streak** — three closed losers in a row: the read is off, stop
  before the fourth.
- **Profit lock** — up 2% realized today (twice the 1% goal): take the
  day. This book's record is winners that round-trip; a good day given
  back is how a profitable week becomes a flat one.
- **Day giveback** — once the day's realized peak has reached the 1% goal,
  giving back half of it stops new entries. A trail on the day.
- **Edge gate** — a playbook (swing / intraday) whose last 20 closed trades
  lost money opens no new ones until it is fixed. `app/api/edgeLib.js`;
  the Edge card on the Journal tab shows expectancy in R, profit factor,
  win rate and drawdown by playbook, entry hour, exit reason, symbol and
  catalyst.
- **Tape gate** — a same-day continuation is refused once the name has
  already used 120% of its normal daily range (`app/lib/tape.js`). The
  same read — SPY against VWAP, the opening range, range used — is in the
  Ideas prompt while the session is open.

## Automation safety

- **Daily rules** — see The daily plan above. The autopilot log shows
  `HALTED (<rule>): ...` once when one trips and `RESUMED` when it lifts.
- **Push notifications** — set `NTFY_TOPIC` and every fill, every exit with
  its P&L, every halt, and an autopilot that has gone dark reach your phone
  through [ntfy](https://ntfy.sh). `app/api/notifyLib.js`.
- **One account size** — `ACCOUNT_SIZE` (default $10,000) is read in one
  place, `app/api/accountLib.js`; every cap, bar and limit is a share of it.
- **Kill switch** — the Journal tab's account card has a **Stop new trades**
  button and a meter of today's realized loss against the limit; while
  entries are stopped, a red badge shows in the page header on every tab.
  The same switch is `GET /api/halt` / `POST /api/halt {"halted": true,
  "reason": "..."}` (`{"halted": false}` resumes). Survives a restart.
  Engine: `app/api/riskLib.js`.

## Storage

Ideas and the journal live in SQLite at `data/cockpit.db` (Node's built-in
`node:sqlite`, no native dependency). The JSON files this replaced are
imported once and renamed `*.migrated`. See `app/api/store.js`.

## Tests

`npm test` runs the exit rules (`app/api/order/exitRules.js`) against the
trades named in their own comments — NVDA, SPCX, AVGO, INTC and the rest —
plus the store and the daily loss limit. Change a threshold and the tests say
what it does to the record before the market does.

## Data

- **Tradier** — quotes, chains, history, extended-hours prints.
- **FMP** (optional, Starter plan+) — news, earnings/macro calendar, analyst
  targets, top movers.
- **Anthropic** — powers the Ideas tab.
