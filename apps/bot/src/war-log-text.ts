import type { WarLogKind } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";
import { warLogLine } from "@factions/copy";
import { lineMarkdown } from "./site-links.js";

/** The #war-log lines (spec §9.2), rendered from the shared copy. */
export function warLogText(e: { kind: WarLogKind; occurredAt?: Date; payload: NoticePayload }, siteBaseUrl: string): string {
  // ⚠️ toISOString() throws on an invalid Date; a renderer must never throw.
  const iso = e.occurredAt && Number.isFinite(e.occurredAt.getTime()) ? e.occurredAt.toISOString() : undefined;
  return lineMarkdown(warLogLine(e.kind, e.payload as Record<string, unknown>, iso), siteBaseUrl);
}
