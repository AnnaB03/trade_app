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

## Automation safety

- **Daily loss limit** — when today's realized loss (closed trades, net of
  fees) reaches `DAILY_LOSS_LIMIT_PCT` of the account (default 3%), the
  entry path refuses every new position until the next session. Exits keep
  running. The autopilot log shows `HALTED (daily_loss): ...`.
- **Kill switch** — `GET /api/halt` shows the state and today's P&L against
  the limit; `POST /api/halt {"halted": true, "reason": "..."}` stops new
  entries by hand, `{"halted": false}` resumes. Survives a restart.
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
