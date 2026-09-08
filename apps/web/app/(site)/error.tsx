"use client";

import { Page, PageHead, Body, btnPrimary, link } from "@/app/components/ui";

/**
 * The (site) group's error boundary: an uncaught throw in a page lands here
 * instead of on Next's blank default. Nothing about the error is shown —
 * `error.message` can carry a query or a path — only the way out.
 */
export default function SiteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <PageHead kicker="Error" title="That page broke" />
      <Body className="flex max-w-[40rem] flex-col gap-5">
        <p className="text-ink-2">Something went wrong while building this page. It has been noted. Try again, or go back to <a className={link} href="/">the front</a>.</p>
        <button type="button" className={`${btnPrimary} self-start`} onClick={reset}>Try again</button>
      </Body>
    </Page>
  );
}
