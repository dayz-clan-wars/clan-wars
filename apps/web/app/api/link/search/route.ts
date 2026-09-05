import type { NextRequest } from "next/server";
import { searchGamertags } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

export async function GET(req: NextRequest) {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return json({ matches: await searchGamertags(q.slice(0, 64)) });
}
