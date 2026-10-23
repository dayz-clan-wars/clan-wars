import type { Metadata } from "next";
import { Page, PageHead, Body, SegNav } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
import { liveNav } from "@/lib/live-items";
import RadioView from "./radio-view";

export const metadata: Metadata = { title: "Clan Wars — radio" };

/**
 * The bunker radio decoder. Public (lib/auth/gate.ts) and static: it reads
 * nothing from the server; the microphone and the decoding stay in the browser.
 */
export default function RadioPage() {
  return (
    <Page wide>
      <PageHead kicker="Live" title="Radio" guide={guideLinkFor("/radio")} />
      <Body>
        {/* Below the head, not beside it: ten tabs plus the guide line squeezed the title to "RADI / O" at laptop width. */}
        <SegNav label="Feed" items={liveNav("/radio")} className="mb-6" />
        <RadioView />
      </Body>
    </Page>
  );
}
