import { NextResponse } from "next/server";
import { ghostReport } from "../ghostStopLib";

// The 35% stop recorded test, side by side with the live trades (ghostStopLib.js). Read-only.
export function GET() {
  return NextResponse.json(ghostReport());
}
