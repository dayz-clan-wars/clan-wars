/** Monday 00:00 UTC of the week containing `d` (spec §8.3). */
export function weekStartOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return start;
}
