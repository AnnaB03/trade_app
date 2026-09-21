import { NextResponse } from "next/server";
import { upcomingEarnings, macroEvents, todayET } from "../eventsLib";
import { calendarEffects } from "../calendarRulesLib";

/* Calendar data: today's high-impact US macro releases (with ET times),
   upcoming macro releases and earnings within `days` (default 7), and
   today's recurring calendar effects (OPEX, month-end, etc.).
   Powers both the closed-market Overnight Brief (macro/earnings, 7-day
   default — unchanged) and the always-visible News tab (wider window via
   ?days=, plus macroUpcoming and effects). Degrades to empty lists without
   FMP_API_KEY. */

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const symbols = params.get("symbols");
  const days = Math.min(60, Math.max(1, Number(params.get("days")) || 7));
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  const today = todayET();
  const effects = calendarEffects(today).labels;
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, macro: [], macroUpcoming: [], earnings: [], effects });
  }
  try {
    const syms = symbols.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const soon = new Date(new Date(today).getTime() + days * 86400000).toISOString().slice(0, 10);

    const [macroAll, ...earnLists] = await Promise.all([
      macroEvents(),
      ...syms.map((s) => upcomingEarnings(s.toUpperCase()).catch(() => [])),
    ]);

    const macro = macroAll
      .filter((m) => m.date === today)
      .map((m) => ({ label: m.label, timeET: m.timeET }));

    const macroUpcoming = macroAll
      .filter((m) => m.date >= today && m.date <= soon)
      .map((m) => {
        const dd = Math.round((new Date(m.date) - new Date(today)) / 86400000);
        return { label: m.label, date: m.date, timeET: m.timeET, when: dd === 0 ? "today" : dd === 1 ? "tomorrow" : `in ${dd} days` };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const earnings = earnLists
      .flat()
      .filter((e) => e.date >= today && e.date <= soon)
      .map((e) => {
        const sym = e.label.split(" ")[0];
        const dd = Math.round((new Date(e.date) - new Date(today)) / 86400000);
        return { symbol: sym, date: e.date, when: dd === 0 ? "today" : dd === 1 ? "tomorrow" : `in ${dd} days` };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return NextResponse.json({ available: true, macro, macroUpcoming, earnings, effects });
  } catch (e) {
    return NextResponse.json({ available: false, macro: [], macroUpcoming: [], earnings: [], effects, reason: String(e.message || e) });
  }
}
