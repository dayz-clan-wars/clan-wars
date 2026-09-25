import { ROSTER_COOLDOWN_MS } from "@factions/domain";
import { days } from "@/lib/format";
import { SubmitButton, btnDanger, checkbox } from "@/app/components/ui";

/**
 * The Leave panel's form. L2: the cooldown is a number BEFORE the player
 * commits, from the same rule the success message reads (packages/copy
 * src/clan.ts LEAVE.ok); test/leave-form.test.tsx holds the two together.
 */
export function LeaveForm() {
  return (
    <form action="/api/clan/leave" method="post">
      <label className="flex min-h-[44px] items-start gap-3 text-sm leading-relaxed text-ink-2">
        <input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} />
        {`I understand I cannot join a clan again for ${days(ROSTER_COOLDOWN_MS)} after leaving.`}
      </label>
      <SubmitButton className={`mt-3.5 ${btnDanger}`} pending="Leaving…">Leave the clan</SubmitButton>
    </form>
  );
}
