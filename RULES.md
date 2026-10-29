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
  - (the daily loss halt is off since 2026-10-15: `DAILY_LOSS_LIMIT_PCT=0`; the default is 10%);
  - the 20% option stop (judged at the mid), and the $500 cap for shares;
  - the 15% / 20% / total caps;
  - the idea's own trigger must fire;
  - price already through the invalidation, or already at the target;
  - an exact duplicate of an open position;
  - no usable stop;
  - a spread over 12% of the premium, or over half the loss limit on arrival;
  - an option under **$1**;
  - an idea from an earlier session, or one that already reached its target;
  - the other side of a stock already held, or a second position in the same stock, side and playbook;
  - a third trade of one idea in a day;
  - any new option trade from **14:00** (no overnight carry);
  - the other side of a stock within 30 minutes of a stop-out on it;
  - a target within 0.15% of the live price (`TARGET_MARGIN_PCT`);
  - a second fade of the same stock in a day, buying the other side of a stock within 30 minutes of the last entry, or buying the same side again within 30 minutes of a sale (blocked trades go to the shadow book with `blockedBy`);
  - at most **8** entries per stock per day.

With learning mode off, the table below applies as written.

| Rule | Value | Where | Since |
|---|---|---|---|
| Risk per trade | **sized to lose 2% of the account ($500) at its stop**; options are sold by the 20% stop (judged at the mid) or the idea's level, with **no dollar cap** since 2026-10-15 (MU $3,040 contract cut at −16% by the cap, worth +$1,050 an hour later); shares keep the $500 cap, their only loss limit | `entryRules.RISK_PER_TRADE_PCT`, `exitRules.MAX_LOSS_PCT` | 2026-10-15 |
| Daily loss limit | **off since 2026-10-15** (`DAILY_LOSS_LIMIT_PCT=0`, the owner: "remove that stop at the daily loss limit for now since we are still learning"); the code default is 10% ($2,500); 5% from 2026-10-13 | `riskLib.DAILY_LOSS_LIMIT_PCT` | 2026-10-15 |
| Buys are priced at | the ask (`ENTRY_AT_MID=true` for the mid) | `entryRules.payPrice` | 2026-10-14 |
| New positions only in | the regular session | `entryRules.entriesAllowed` | 2026-10-13 |
| Position cap | 15% of the account | `sizingLib.OPTION_HARD_PCT` | 2026-10-06 |
| One stock | 20% of the account | `entryRules.MAX_SYMBOL_EXPOSURE_PCT` | 2026-10-06 |
| Entries per stock per day | 4, then a 45-minute wait after an exit | `entryRules` | 2026-10-13 |
| Idea minimums | conviction 2, reward:risk 1.5 | `entryRules` | — |
| New option trades opened until | **14:00 ET**, learning mode too (was 15:00, then 15:30). Bought from 14:00 since 10-07: 32 trades, −$2,731, losing in both halves (−$334, then −$2,397). Blocked ideas are recorded to the shadow book as `after_14` | `entryRules.lateEntryRefused` | 2026-10-22 |
| Fade symbols | **live fades on index ETFs only** (QQQ, SPY, IWM, DIA; `FADE_SYMBOLS` overrides); single-stock fades recorded as `fade_single_stock`, not placed (QQQ 4 of 5 won; single stocks 0 of 7, −$2,302). Review after 20+ fades | `fadeLib.FADE_SYMBOLS` | 2026-10-22 |
| Fade vs the tape | **no fade against a one-sided read**: skipped when 3+ of the model's ideas from the last 30 minutes point the other way and outnumber its side (every big losing fade had 5–8 opposite to 0–3, −$2,841; the four winners did not, +$887). Fitted on 12 trades; scored in the shadow book as `fade_vs_tape` | `fadeLib.fadeAgainstTape` | 2026-10-22 |
| Fade sides | **fade calls only** (fading put ideas in a transitioning tape: 4 for 4, +$887); fade puts and the fade scan off (0 for 4, −$1,235). `FADE_ACTIONS=CALL,PUT` restores both | `fadeLib.FADE_ACTIONS` | 2026-10-15 |
| Overnight | **no overnight carry for options: every option is sold from 15:45** (restored 2026-10-29). The 14+ day carry ran 10-27 15:15 to 10-29 and lost both trades it held (ORCL 11/20 −$381, QQQ 11/20 −$730 through its stop on the gap); options held overnight on the record won 3 of 26, −$9,720. `CARRY_MIN_DTE=14` restores it; `CARRY_OVERNIGHT=true` carries every option | `exitRules.carriesOvernight` | 2026-10-29 |
| First buy of the day | **no new buy before 10:00 ET**, options and shares, in learning mode too. Swing options bought 9:30–9:59 since 10-07 won 1 of 12, −$3,694 (0 of 5, then 1 of 7). Blocked option ideas go to the shadow book as `before_10` | `entryRules.tooEarlyToEnter` | 2026-10-29 |
| Expiry day | options expiring today **are** bought: the ban added and undone on 2026-10-22 would have blocked +$2,201 of winners (ORCL +$1,182, INTC +$751, ORCL +$268) for one −$481 loss | `entryRules.expiresToday` (helper only) | 2026-10-22 |
| Flip after a stop | **no buying the other side of a stock within 30 minutes of a stop-out on it** (10-19: NVDA and INTC puts bought 2 seconds after their calls stopped; replayed: 8 losers −$3,152, 3 winners +$852) | `entryRules.flipAfterStop` | 2026-10-22 |
| Trades per idea | **at most 2 per idea per day**; the re-buy exemption **once per idea per day** (AVGO 10-15: one idea traded 5 times, −$941; the cap would have blocked 9 trades since the restart, −$728, 4% of winning dollars) | `entryRules.ideaCapReached`, `rebuyCheck` | 2026-10-16 |
| Both sides / duplicates | **never both sides of one stock at once** (4 losers −$1,113 against 2 winners +$110 since the restart); **one position per stock, side and playbook** whatever the contract (a switched expiry had let ORCL hold two same-day calls) | `entryRules.bothSidesOpen`, `samePlaybookPosition` | 2026-10-15 |
| Fades / flips / re-buys | one fade per stock per day; no opposite-side entry on a stock within 30 minutes; **no same-side re-buy within 30 minutes of any sale of it**, except after a stop or max-loss sale while the stock is still on the right side of the idea's level (2026-10-15: 11 such re-buys had lost $444; MU's blocked re-buy would have made about +$1,000). From the 10-14 replay: +$6,454 / +$3,065 at 3% worse fills, against +$5,274 / −$2,874 without | `entryRules.fadeLimitReached`, `flipTooSoon` | 2026-10-14 |
| News playbook | the risk & market agent may propose up to 3 same-day ideas per report; the server checks the levels (right sides, 1.5:1 from the trigger, within 3% of the price) and picks a 1–4 day contract itself; traded live as strategy `news` under every rule above, shown in their own Ideas section; none after 15:00 ET | `newsIdeasLib`, `contractLib` | 2026-10-14 |
| Entry test | triggered ideas split by id: half buy at the break, half wait for 2 completed 1-minute closes beyond it (`ENTRY_CONFIRM=all/off`) | `entryRules.entryArm`, `confirmedBreak` | 2026-10-14 |
| Contracts per option trade | 2% of the account / loss at the stop that fires first | `entryRules.sizeOptionEntry` | 2026-10-14 |
| Loss checks judged at | the option's **mid** (stop and max-loss); sales still at the bid; profit rules at the bid (MU sold −$536 on a bid dip while the stock had moved 0.3%) | `exitRules.decideProfitExit` | 2026-10-15 |
| Option stop | from its stock's p90 30-minute adverse move, **20–35%; else 20%** (was 8–35%, else 10%: replayed on 31 trades, 10% netted −$1,502 against −$621 at 20% for the same $ risk) | `swingLib.optionStopPct`, `exitRules.HARD_LOSS_PCT` | 2026-10-14 |
| Contract switch | when the idea's contract is over 6% wide, the tightest contract with the same stock and type, delta within ±0.08, expiry from 3 days shorter (never under 2 days for swing, 1 for same-day) to 7 days longer, and a price inside the 15% cap; never refuses (MU's 15.8% $885c → Oct 19 $900c at 1.4%). The same idea counts as a duplicate whatever contract it is in | `contractLib.liquidAlternative` | 2026-10-15 |
| Stacked warnings | **an idea with 3+ different warnings (soft rules) at once is refused**, in learning mode too; one or two still trade and are recorded. Same-day options bought before 14:00 with 3+: −$1,988 (10 of 20 won), then −$2,081 (3 of 10 won); saves ≈$4,070, gives up ≈$2,460 of winners. Refused ideas go to the shadow book as `stacked_warnings` | `entryRules.stackedWarnings` | 2026-10-27 |
| Option price at entry | **at least $1**, hard in learning mode too. Options under $1 since 10-07: AAL ×5, 0 winners, −$2,490; one cent is 3–5% of the price, so the 20% stop fills past itself. Blocked ideas go to the shadow book as `under_1` | `entryRules.MIN_OPTION_PREMIUM` | 2026-10-23 |
| Spread at entry | soft (recorded) over 6% of the premium or 40% of the loss limit; **hard over 12% of the premium or 50% of the loss limit** (MU 10/21 $885c: 15.8%, $480 of $500 on arrival) | `entryRules` | 2026-10-15 |
| Selection | no calls in an uptrend, no puts in a transitioning tape, no calls after 14:00, no FDA | `selectionLib` | 2026-10-13 |
| Watch-only (record, never trade) | the fade, the fade scan | `entryRules.isWatchOnly` | 2026-10-14 |
| Same-day ideas | trade live (`INTRADAY_LIVE=false` to record only) | `entryRules.isWatchOnly` | 2026-10-14 |
| Fades | not before 10:00; stop at least 0.5% of the price away | `fadeLib` | 2026-10-14 |
| Quick profit (options) | **an option up over $50 at the bid is sold right away**, before fees (options only since the evening of 10-27: "lets keep selling over 50 only on options"); shares keep their own exits; checked every minute. The owner: "sell whatever goes to more than +$50 right away". `PROFIT_TAKE_USD=0` turns it off | `exitRules.PROFIT_TAKE_USD` | 2026-10-27 |
| Take profits (options) | **at +50%, or when the stock reaches the idea's target; nothing else sells for profit.** Same-day contracts still flat from 15:45. Replayed: −$676 against −$621 for the old rules and −$1,435 for +50% alone; the owner's choice. `PROFIT_EXITS=legacy` restores the trail (+5%, 25% giveback), the quick +7% and the end-of-day bar | `exitRules.PROFIT_TAKE_PCT` | 2026-10-14 |
| Account | margin: proceeds reusable at once; 3 day trades per 5 days under $25K equity | `simBroker` | 2026-10-13 |
| Broker rules | limit orders only, no shorting, no option writing, $0.35 a contract each way | `simBroker` | 2026-10-07 |
| Idea model | Opus | `suggestions/route.js` | 2026-10-13 |
| A losing recent record | trades at 1/2 size (0 to −0.25R a trade) or 1/4 (worse), never stops | `edgeLib.edgeRiskMultiplier` | 2026-10-14 |
| Same-day ideas are asked for | 1.8× reward to risk at the trigger | `suggestions/route.js` prompt | 2026-10-14 |
