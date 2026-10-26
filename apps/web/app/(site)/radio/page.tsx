import type { Metadata } from "next";
import { Page, PageHead, Body } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
import RadioView from "./radio-view";

export const metadata: Metadata = { title: "Clan Wars — radio" };

/**
 * The bunker radio decoder. Public (lib/auth/gate.ts) and static: it reads
 * nothing from the server; the microphone and the decoding stay in the browser.
 */
export default function RadioPage() {
  return (
    <Page wide>
      <PageHead kicker="Bunkers" title="Radio" guide={guideLinkFor("/radio")} />
      <Body>
        <RadioView />
      </Body>
    </Page>
  );
}
