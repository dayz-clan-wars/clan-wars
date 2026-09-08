import type { Metadata } from "next";
import { SignInCard } from "@/app/components/sign-in-card";
import { safeNextPath } from "@/lib/auth/next-path";

export const metadata: Metadata = {
  title: "Clan Wars — sign in",
  robots: { index: false, follow: false },
};

/** ⚠️ Never echo the raw ?error= value into the page — it is attacker-supplied. */
const ERRORS: Record<string, string> = {
  state: "That sign-in link expired or did not come from here. Start again.",
  discord: "Discord did not answer. This is usually temporary — try again shortly.",
  banned: "You are banned from the Clan Wars Discord, so we cannot add you to it.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const rawError = typeof params.error === "string" ? params.error : "";

  return (
    <div className="flex min-h-[calc(100dvh-var(--spacing-bar))] flex-col items-center px-4 pb-18 pt-7">
      <SignInCard
        step="Sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your clan, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref={`/api/auth/discord?next=${encodeURIComponent(next)}`}
        footnote="One character per account. You need to be in the Clan Wars Discord — we will offer to add you if you are not."
        error={ERRORS[rawError]}
      />
    </div>
  );
}
