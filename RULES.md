# Cockpit trading rules

Every rule below is agreed with the account owner and pinned by
`tests/rules.contract.test.js`. A change that breaks one of those tests is
wrong, or it is a rule change — and rules change only when the owner agrees.
When one does, update the test in the same commit with the date and the reason.

`npm test` runs everything. A git pre-push hook (`scripts/pre-push.hook`,
install with `cp scripts/pre-push.hook .git/hooks/pre-push`) refuses to push
when any test fails.

## Learning mode (2026-10-14)

The owner, 2026-10-14: *"remove all the blockers that will block you from learning ... I
need you to always buy->sell->learn ... always try and always learn from every single
contract or trade."* On unless `LEARNING_MODE=false` (`entryRules.learningMode`).

- **Soft rules record instead of refusing.** Each one is written on the trade as
  `learningOverrides`, and `/api/edge` splits results by it (`byLearning`,
  `byOverriddenRule`). The soft rules are: conviction, the edge throttle, selection,
  staleness, the extreme stand-down, reward:risk, a consumed idea, the 4-a-day cap, the
  cooldown, the tape gate, the 15:00 same-day cut-off, a same-day contract over budget
  (taken at 1), the spread caps, watch-only (the fade and the fade scan now trade), and
  PDT on paper.
- **The safety core still refuses:**
  - paper only;
  - the regular session only;
  - the 10% daily loss halt ($2,500);
  - the 2% max-loss exit ($500) and the 20% option stop;
  - the 15% / 20% / total caps;
  - the idea's own trigger must fire;
  - price already through the invalidation, or already at the target;
  - an exact duplicate of an open position;
  - no usable stop;
  - an idea from an earlier session, or one that already reached its target;
  - same-day contracts after **15:30**;
  - a second fade of the same stock in a day, or buying the other side of a stock within 30 minutes of the last entry (blocked trades go to the shadow book with `blockedBy`);
  - at most **8** entries per stock per day.

With learning mode off, the table below applies as written.

| Rule | Value | Where | Since |
|---|---|---|---|
| Most one trade may lose | **2% of the account ($500 at $25K)**; 1% from 2026-10-08 | `exitRules.MAX_LOSS_PCT`, `entryRules.RISK_PER_TRADE_PCT` | 2026-10-14 |
| Daily loss limit | **10% of the account ($2,500)**; 5% from 2026-10-13 | `riskLib.DAILY_LOSS_LIMIT_PCT` | 2026-10-14 |
| Buys are priced at | the ask (`ENTRY_AT_MID=true` for the mid) | `entryRules.payPrice` | 2026-10-14 |
| New positions only in | the regular session | `entryRules.entriesAllowed` | 2026-10-13 |
| Position cap | 15% of the account | `sizingLib.OPTION_HARD_PCT` | 2026-10-06 |
| One stock | 20% of the account | `entryRules.MAX_SYMBOL_EXPOSURE_PCT` | 2026-10-06 |
| Entries per stock per day | 4, then a 45-minute wait after an exit | `entryRules` | 2026-10-13 |
| Idea minimums | conviction 2, reward:risk 1.5 | `entryRules` | — |
| Same-day contracts opened until | 15:00 ET | `entryRules.lateEntryRefused` | 2026-10-08 |
| Fades / flips | one fade per stock per day; no opposite-side entry on a stock within 30 minutes. From the 10-14 replay: +$6,454 / +$3,065 at 3% worse fills, against +$5,274 / −$2,874 without | `entryRules.fadeLimitReached`, `flipTooSoon` | 2026-10-14 |
| Entry test | triggered ideas split by id: half buy at the break, half wait for 2 completed 1-minute closes beyond it (`ENTRY_CONFIRM=all/off`) | `entryRules.entryArm`, `confirmedBreak` | 2026-10-14 |
| Contracts per option trade | 2% of the account / loss at the stop that fires first | `entryRules.sizeOptionEntry` | 2026-10-14 |
| Option stop | from its stock's p90 30-minute adverse move, **20–35%; else 20%** (was 8–35%, else 10%: replayed on 31 trades, 10% netted −$1,502 against −$621 at 20% for the same $ risk) | `swingLib.optionStopPct`, `exitRules.HARD_LOSS_PCT` | 2026-10-14 |
| Spread at entry | at most 6% of the premium and 40% of the loss limit | `entryRules` | 2026-10-12/14 |
| Selection | no calls in an uptrend, no puts in a transitioning tape, no calls after 14:00, no FDA | `selectionLib` | 2026-10-13 |
| Watch-only (record, never trade) | the fade, the fade scan | `entryRules.isWatchOnly` | 2026-10-14 |
| Same-day ideas | trade live (`INTRADAY_LIVE=false` to record only) | `entryRules.isWatchOnly` | 2026-10-14 |
| Fades | not before 10:00; stop at least 0.5% of the price away | `fadeLib` | 2026-10-14 |
| Take profits (options) | **at +50%, or when the stock reaches the idea's target; nothing else sells for profit.** Same-day contracts still flat from 15:45. Replayed: −$676 against −$621 for the old rules and −$1,435 for +50% alone; the owner's choice. `PROFIT_EXITS=legacy` restores the trail (+5%, 25% giveback), the quick +7% and the end-of-day bar | `exitRules.PROFIT_TAKE_PCT` | 2026-10-14 |
| Account | margin: proceeds reusable at once; 3 day trades per 5 days under $25K equity | `simBroker` | 2026-10-13 |
| Broker rules | limit orders only, no shorting, no option writing, $0.35 a contract each way | `simBroker` | 2026-10-07 |
| Idea model | Opus | `suggestions/route.js` | 2026-10-13 |
| A losing recent record | trades at 1/2 size (0 to −0.25R a trade) or 1/4 (worse), never stops | `edgeLib.edgeRiskMultiplier` | 2026-10-14 |
| Same-day ideas are asked for | 1.8× reward to risk at the trigger | `suggestions/route.js` prompt | 2026-10-14 |
