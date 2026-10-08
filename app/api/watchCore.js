/* The core watchlist: what every scheduled refresh analyses.

   Chosen 2026-10-08 from a screen of ~100 liquid names on real data, because
   the old list was starving the book of ideas: three of its seven names (AAL,
   NOK, FEIM) barely move, and most of each refresh went to thin "top mover"
   tickers the model rejected every time. Over 90% of answers were WAIT.

   What earned a place: it moves (average daily range of roughly 2%+ of price),
   its options are liquid (at-the-money spread of about 5% or less, weekly
   expirations), and a ~3-week at-the-money call costs under the $1,500 position
   cap of a $10K account — so an idea on it can actually be bought.

   Four are here despite failing the last test (TSLA, AMD, MU: a 3-week
   contract costs $1,800-$4,900). They are the most liquid names on the board
   and are tradeable through the 1-3 day contracts the intraday playbook and
   the short-dated fallback use. SPY and QQQ are here for the tape as much as
   for trades.

   Re-screen when the account size changes: the cost test is account-relative. */
export const CORE_SYMBOLS = [
  "SPY", "QQQ",                                   // the tape
  "NVDA", "TSLA", "AMD", "MU",                    // most liquid; short-dated only where noted above
  "INTC", "QCOM", "ORCL", "AMZN", "GOOGL",        // large, tight spreads, contract fits
  "PLTR", "HOOD", "SPCX", "RKLB", "SMCI", "OKLO", // high daily range, contract fits
  "SOFI", "MARA",                                 // cheap contracts, heavy volume
];
