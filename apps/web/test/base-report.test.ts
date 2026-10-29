import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_REASONS } from "@factions/roster";
import { REPORT_COPY } from "../lib/report-copy";

const ROUTE = join(import.meta.dirname, "..", "app", "api", "base", "report", "route.ts");
const routeText = readFileSync(ROUTE, "utf8");

const BUTTON = join(import.meta.dirname, "..", "app", "(site)", "base", "report-button.tsx");
const buttonText = readFileSync(BUTTON, "utf8");

const PAGE = join(import.meta.dirname, "..", "app", "(site)", "base", "page.tsx");
const pageText = readFileSync(PAGE, "utf8");
const INCIDENTS = join(import.meta.dirname, "..", "app", "components", "witnessed-incidents.tsx");
const incidentsText = readFileSync(INCIDENTS, "utf8");
const CLAN_PAGE = join(import.meta.dirname, "..", "app", "(site)", "clan", "page.tsx");
const clanPageText = readFileSync(CLAN_PAGE, "utf8");

describe("a refusal reason renders as copy, never as a raw enum", () => {
  it("REPORT_COPY is total over REPORT_REASONS", () => {
    for (const reason of REPORT_REASONS) {
      expect(typeof REPORT_COPY[reason]).toBe("string");
      expect(REPORT_COPY[reason]!.length).toBeGreaterThan(10);
    }
  });
  it("has no stray keys beyond the union", () => {
    const keys = Object.keys(REPORT_COPY);
    expect(keys.sort()).toEqual([...REPORT_REASONS].sort());
  });
});

describe("the base report route", () => {
  it("is a POST", () => {
    expect(routeText).toMatch(/export async function POST\(/u);
    expect(routeText).not.toMatch(/export async function GET\(/u);
  });

  it("refuses an unauthenticated caller before touching the store — sessionOr401, the routes' own gate", () => {
    expect(routeText).toMatch(/from "@\/lib\/api"/u);
    expect(routeText).toContain("sessionOr401()");
    const gateIdx = routeText.indexOf("sessionOr401()");
    const callIdx = routeText.indexOf("reportIncident(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(gateIdx);
  });

  it("validates incidentId as a positive integer BEFORE calling reportIncident — Number(undefined) is NaN and must never reach the store", () => {
    const validateIdx = routeText.indexOf("Number.isInteger(incidentId)");
    const callIdx = routeText.indexOf("reportIncident(");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(validateIdx);
  });

  it("answers through lib/api's json() helper, which carries no-store, private on every response — never a hand-rolled NextResponse.json", () => {
    expect(routeText).toContain("json(");
    expect(routeText).not.toMatch(/NextResponse\.json\(/u);
    expect(routeText).not.toMatch(/new Response\(/u);
  });

  it("every refusal answers with copy, keyed off REPORT_COPY, not a bare reason string", () => {
    expect(routeText).toContain("REPORT_COPY[");
  });
});

describe("the report button", () => {
  it("is a client component", () => {
    expect(buttonText).toMatch(/^"use client";/mu);
  });

  it("⚠️ never imports the roster package's barrel — next build is the only thing that catches this, and it broke a deploy on 2026-09-13", () => {
    expect(buttonText).not.toContain("@factions/roster");
  });

  it("requires a second press before it posts — the confirm step is a safety control, not decoration", () => {
    // The first press only arms the button (sets state); it must not call submit().
    const firstPressIdx = buttonText.indexOf("setArmed(true);");
    const submitCallIdx = buttonText.indexOf("void submit()");
    expect(firstPressIdx).toBeGreaterThan(-1);
    expect(submitCallIdx).toBeGreaterThan(-1);
    // The button that actually calls submit() only exists inside the `armed` branch.
    const armedBranchIdx = buttonText.indexOf("if (armed)");
    expect(armedBranchIdx).toBeGreaterThan(-1);
    expect(submitCallIdx).toBeGreaterThan(armedBranchIdx);
  });

  it("the confirm step states plainly that this bans the named players automatically", () => {
    expect(buttonText).toMatch(/automatically bans/u);
  });

  it("posts JSON with incidentId, never a form redirect", () => {
    expect(buttonText).toContain('"content-type": "application/json"');
    expect(buttonText).toContain("incidentId");
  });
});

describe("the /base page's incident list", () => {
  it("renders only when linked and there is at least one reportable incident", () => {
    expect(pageText).toContain("view.linked && view.incidents.length > 0");
  });

  it("is available to a clan's members too, not only a solo declarant — it sits outside the !view.inClan branch", () => {
    const inClanBlockStart = pageText.indexOf("view.linked && !view.inClan &&");
    const inClanBlockEnd = pageText.indexOf("</>\n        )}", inClanBlockStart);
    const incidentsIdx = pageText.indexOf("view.linked && view.incidents.length > 0");
    expect(inClanBlockStart).toBeGreaterThan(-1);
    expect(incidentsIdx).toBeGreaterThan(inClanBlockEnd);
  });

  it("renders the shared incident list, which shows the evidence — coordinates included — on the viewer's own base pages only", () => {
    expect(pageText).toContain("<WitnessedIncidents");
    expect(incidentsText).toContain("gridRef(a.x, a.z)");
  });

  it("imports the report button as a prop-driven component, never @factions/roster's runtime inside it", () => {
    expect(incidentsText).toContain('from "@/app/(site)/base/report-button"');
    // ⚠️ A type import is erased at build; a value import would pull the pooled client toward the client bundle.
    expect(incidentsText).not.toMatch(/^import \{[^}]*\} from "@factions\/roster"/mu);
  });
});

describe("the /clan page's incident list", () => {
  it("renders the same shared list, only when there is at least one incident", () => {
    expect(clanPageText).toContain("incidents.length > 0 && <WitnessedIncidents");
  });

  it("offers the button to officers and the leader only — reportIncidentDb's own gate", () => {
    expect(clanPageText).toContain("canCharge={officer}");
  });

  it("carries the #incidents anchor the incident-ready notice links to", () => {
    expect(incidentsText).toContain('id="incidents"');
  });
});
