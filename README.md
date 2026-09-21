# Options Cockpit

A personal options-trading desk: live quotes and chains (Tradier), a
defined-risk position builder with hard safety gates, AI-generated trade
ideas that carry a real plan (entry trigger, stop, target, conviction) and
grade themselves against what actually happened, and a trade journal.

Order routes are hard-locked to Tradier's **sandbox** — paper trading only.

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

## Data

- **Tradier** — quotes, chains, history, extended-hours prints, sandbox orders.
- **FMP** (optional, Starter plan+) — news, earnings/macro calendar, analyst
  targets, top movers.
- **Anthropic** — powers the Ideas tab.
