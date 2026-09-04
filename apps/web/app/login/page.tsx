import type { Metadata } from "next";
import { SignInCard } from "../components/sign-in-card";
import { archivo, archivoBlack, spaceMono } from "../fonts";
import { safeNextPath } from "@/lib/auth/next-path";
import s from "../auth.module.css";

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
  const rawNext = typeof params.next === "string" ? params.next : null;
  const next = safeNextPath(rawNext);
  const rawError = typeof params.error === "string" ? params.error : "";

  return (
    <div className={`${s.page} ${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <SignInCard
        step="Sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your faction, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref={`/api/auth/discord?next=${encodeURIComponent(next)}`}
        footnote="One character per account. You need to be in the Clan Wars Discord — we will offer to add you if you are not."
        error={ERRORS[rawError]}
      />
    </div>
  );
}
