import { REPORT_REASONS } from "@factions/roster";

/** Not exported by the package root — `REPORT_REASONS` is, so the union is derived from it here rather than duplicated. */
type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * Every refusal `reportIncident` can answer with, as a sentence for the
 * report button — never rendered as a raw enum. `Record<ReportReason, …>`
 * makes the map total at compile time; `test/base-report.test.ts` also
 * checks it at runtime against `REPORT_REASONS` so a reason added to the
 * package without a line here fails loudly rather than rendering blank.
 */
export const REPORT_COPY: Record<ReportReason, string> = {
  "not-linked": "Link your character before you can press charges.",
  "not-owner": "Only the player who declared this base can press charges here.",
  "not-officer": "Only a clan officer or the leader can press charges here.",
  "no-incident": "That incident could not be found.",
  "window-closed": "The report window on this incident has closed.",
  "already-reported": "This incident has already been reported.",
};
