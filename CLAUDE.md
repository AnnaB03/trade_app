# Options Cockpit: standing instructions

**The main goal is to learn: always buy → sell → learn.** The owner said so on 2026-10-14:
"remove all the blockers that will block you from learning ... always try and always
learn from every single contract or trade."

- Learning mode (`app/api/order/entryRules.js`, on unless `LEARNING_MODE=false`). An idea
  whose trigger fires is traded. A soft rule that would have refused it is written on the
  journal row as `learningOverrides`, and the edge report scores each rule on real fills.
- New concerns become recorded overrides, not refusals. A new hard refusal needs the
  owner's agreement.
- The safety core still refuses:
  - paper only;
  - the regular session only;
  - the daily loss halt;
  - the 1% max-loss exit and the option stop;
  - the 15% position, 20% per-symbol and total-capital caps;
  - the idea's trigger has not fired;
  - price is already through the invalidation, or already at the target;
  - an exact duplicate of an open position;
  - no usable stop;
  - same-day contracts after 15:30;
  - more than 8 entries per stock per day.
- When nothing is trading, that is the bug. Print every idea's refusal reason and fix the cause.
- Every agreed rule is in `RULES.md` and pinned by `tests/rules.contract.test.js`. Never push
  red tests; the pre-push hook enforces this.
- Paper only. No live orders, and nothing touches real money.
