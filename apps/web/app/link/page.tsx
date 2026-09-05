import type { Metadata } from "next";
import { linkStatus } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { LinkFlow } from "./link-flow";

export const metadata: Metadata = {
  title: "Clan Wars — link your character",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function LinkPage() {
  const session = await currentSession();
  if (!session) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/link">Sign in again</a>.</p>
      </main>
    );
  }
  const status = await linkStatus(session.sub);
  // Dates cross to the client as strings; the component parses them.
  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pb-18 pt-7">
      <LinkFlow initial={JSON.parse(JSON.stringify(status))} />
    </main>
  );
}
