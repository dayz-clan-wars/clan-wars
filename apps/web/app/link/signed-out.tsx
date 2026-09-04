import { SignInCard } from "../components/sign-in-card";

/**
 * State 01 of the prototype. ⚠️ `actionHref="#"` and the onSignIn handler are
 * what keep this a fixture: the real screen at /login uses the same card with
 * a real endpoint behind it.
 */
export function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div onClick={onSignIn}>
      <SignInCard
        step="Step 1 of 3 — sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your faction, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref="#"
        footnote="One character per account. Signing in shows nothing you could not already see — the map and roster need the link."
      />
    </div>
  );
}
