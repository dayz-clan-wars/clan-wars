import type { Metadata } from "next";
import { SignInCard } from "@/app/components/sign-in-card";
import { safeNextPath } from "@/lib/auth/next-path";
import { guideLinkFor } from "@/lib/guide-links";
import { Page } from "@/app/components/ui";

export const metadata: Metadata = {
  title: "Clan Wars — join the Discord",
  robots: { index: false, follow: false },
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);

  return (
    <Page wide>
      {/*
        ⚠️ The button is the consent. Discord will ask for "Join servers for
        you" on the round this starts, and that prompt should follow something
        the player just pressed rather than arriving unexplained.
      */}
      <SignInCard
        step="One step left"
        heading="Join the Discord."
        body="Clan Wars runs out of its Discord server, and the site is for players who are in it. We can add you now — Discord will ask you to confirm."
        action="Join and continue"
        actionHref={`/api/auth/discord?mode=join&next=${encodeURIComponent(next)}`}
        footnote="You can leave the server at any time from Discord. Leaving also ends your access here."
        cardLabel="Join"
        guide={guideLinkFor("/join")}
      />
    </Page>
  );
}
