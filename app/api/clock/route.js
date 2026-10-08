import { NextResponse } from "next/server";
import { getClock } from "../clockLib";

/* Market clock. state: "open" | "closed" | "premarket" | "postmarket" |
   "unknown". See clockLib.js for the caching and for why a slow broker call
   does not turn into "unknown". */
export async function GET() {
  return NextResponse.json(await getClock());
}
