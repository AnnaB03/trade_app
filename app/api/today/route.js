import { NextResponse } from "next/server";
import { upcomingEarnings, macroEvents, todayET } from "../eventsLib";

/* Morning calendar for the Overnight Brief: today's high-impact US macro
   releases (with ET times) and any watchlist symbols reporting earnings today
   or within the next 7 days. Degrades to empty lists without FMP_API_KEY. */

export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, macro: [], earnings: [] });
  }
  try {
    const syms = symbols.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const today = todayET();
    const soon = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10);

    const [macroAll, ...earnLists] = await Promise.all([
      macroEvents(),
      ...syms.map((s) => upcomingEarnings(s.toUpperCase()).catch(() => [])),
    ]);

    const macro = macroAll
      .filter((m) => m.date === today)
      .map((m) => ({ label: m.label, timeET: m.timeET }));

    const earnings = earnLists
      .flat()
      .filter((e) => e.date >= today && e.date <= soon)
      .map((e) => {
        const sym = e.label.split(" ")[0];
        const days = Math.round((new Date(e.date) - new Date(today)) / 86400000);
        return { symbol: sym, date: e.date, when: days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days` };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return NextResponse.json({ available: true, macro, earnings });
  } catch (e) {
    return NextResponse.json({ available: false, macro: [], earnings: [], reason: String(e.message || e) });
  }
}
