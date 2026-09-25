import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { claimContext } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { readKept } from "@/lib/form";
import { when, ago } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { Page, PageHead, Body, Notice, BackLine, SessionLost } from "@/app/components/ui";
import { ClaimForm } from "./claim-form";

export const metadata: Metadata = { title: "Clan Wars — found your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ ceremony: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ceremony: raw } = await params;
  const q = await searchParams;
  const result = typeof q.result === "string" ? q.result : undefined;
  const session = await currentSession();
  if (!session) return <SessionLost next={`/claim/${raw}`} />;
  // ⚠️ The package returns the VIEWER's open ceremony; the id in the URL must be that one, or it is not theirs to see.
  const ctx = await claimContext(session.sub);
  if (!ctx || String(ctx.ceremony.id) !== raw) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  // A refusal about one field — name, tag, flag or roster — is shown at that field too, which takes focus instead of the notice.
  const err = fieldError(result, RESULT_COPY);
  const kept = readKept(q);
  const me = ctx.ceremony.participants.find((p) => p.discordId === session.sub);

  return (
    <Page>
      <PageHead guide={guideLinkFor("/claim/[ceremony]")} kicker="Found your clan" title={`${ctx.ceremony.participants.length} of you raised the flag`}
        sub={<>Witnessed {ago(ctx.ceremony.detectedAt)}. Claim it before {when(ctx.ceremony.expiresAt)}. Whoever claims becomes leader.</>} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice focus={err === null}>{notice}</Notice>}
        <ClaimForm ceremonyId={ctx.ceremony.id} freeFlags={ctx.freeFlags} participants={ctx.ceremony.participants} meDayzId={me?.dayzId ?? null} err={err}
          kept={{ name: kept.get("name"), tag: kept.get("tag"), texture: kept.get("texture"), members: kept.all("member") }} />
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
