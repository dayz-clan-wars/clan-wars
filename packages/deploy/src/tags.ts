/** A release tag this deploy system will act on: `v` then three integers. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

function parts(tag: string): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Semver ordering over release tags. Returns >0 when `a` is newer.
 * Non-release tags sort as older than everything, including each other.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  // At this point pa and pb are both non-null due to the guards above.
  for (let i = 0; i < 3; i += 1) {
    if (pa![i]! !== pb![i]!) return pa![i]! - pb![i]!;
  }
  return 0;
}

/**
 * The newest release tag in `tags`, or null if none qualifies.
 *
 * ⚠️ Ordered by version, never by tag date. `git fetch --tags` reports
 * creation time, so an old tag deleted and re-pushed would look newest and
 * redeploy a past release over the current one.
 */
export function selectNewestTag(tags: string[]): string | null {
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  if (releases.length === 0) return null;
  return releases.reduce((best, t) => (compareSemver(t, best) > 0 ? t : best));
}
