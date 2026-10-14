import { NextResponse } from "next/server";
import { refreshSwingProfile, readSwingProfile } from "../swingLib";
import { CORE_SYMBOLS } from "../watchCore";
import { listExtras } from "../watchExtrasLib";

/* The per-stock adverse-move profiles (swingLib.js). GET shows them;
   ?refresh=true recomputes from 1-minute history (the schedule does this once
   a day before the open). */
export async function GET(req) {
  try {
    const refresh = new URL(req.url).searchParams.get("refresh") === "true";
    const syms = [...new Set([...CORE_SYMBOLS, ...listExtras().map((e) => e.symbol)])];
    const p = refresh ? await refreshSwingProfile(syms, { force: true }) : readSwingProfile();
    return NextResponse.json(p || { asOf: null, symbols: {} });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
