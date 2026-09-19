import type { NoticeGroup } from "./notice-copy";

/**
 * The query string for a link on /notifications.
 *
 * ⚠️ `group` takes `null` to mean "clear it", NOT `undefined`. The first version
 * of this used `o.group ?? group` and the All chip could never clear the filter,
 * because `undefined ?? group` is `group` — nullish coalescing cannot express the
 * difference between "not overridden" and "overridden to nothing".
 */
export function notificationsHref(
  current: { page: number; group: NoticeGroup | undefined },
  o: { page?: number; group?: NoticeGroup | null },
): string {
  const group = o.group === null ? undefined : (o.group ?? current.group);
  const page = o.page ?? current.page;
  const s = new URLSearchParams();
  if (group) s.set("group", group);
  if (page > 1) s.set("page", String(page));
  const qs = s.toString();
  return qs ? `/notifications?${qs}` : "/notifications";
}

/** Today / Yesterday / Earlier, by UTC calendar day — never by elapsed milliseconds. */
export function noticeDay(at: Date, now: Date): "Today" | "Yesterday" | "Earlier" {
  const days = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}
