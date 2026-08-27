/**
 * One in-order subsequence step.
 *
 * A matching token at the current index advances progress; ANY other token is
 * ignored and progress holds. Holding rather than resetting is deliberate: a
 * player who fat-fingers the emote wheel should not have to start over, and a
 * reset-on-mismatch rule would make the flow nearly impossible in a busy area
 * where the player's own idle animations fire.
 *
 * Order is what the sequence proves, so a token that appears LATER in the
 * sequence does not skip ahead — it is simply not the expected token.
 */
export function advance(
  sequence: string[],
  progressIndex: number,
  emoteToken: string,
): { index: number; complete: boolean } {
  const index =
    progressIndex < sequence.length && sequence[progressIndex] === emoteToken
      ? progressIndex + 1
      : progressIndex;
  return { index, complete: index >= sequence.length };
}
