import { NO_PROFILE } from "@/lib/stats-copy";
import { Page, PageHead, Body, BackLine } from "@/app/components/ui";

export default function PlayerNotFound() {
  return (
    <Page>
      <PageHead kicker="Player" title="No such player" />
      <Body className="max-w-[40rem]">
        <p className="text-ink-2">{NO_PROFILE}</p>
        <BackLine href="/players">Player boards</BackLine>
      </Body>
    </Page>
  );
}
