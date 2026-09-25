import { NOTICE_GROUPS, type NoticeGroup } from "@/lib/notice-copy";

/**
 * The filter row on /notifications. M7: every chip is 44px tall — they were
 * 34px, the smallest targets on a page read mostly on phones. Control edges
 * are rule-3 (globals.css: the boundary that is the only affordance).
 */
export function FilterChips({ group, href }: { group: NoticeGroup | undefined; href: (o: { page?: number; group?: NoticeGroup | null }) => string }) {
  const chip = (label: string, on: boolean, to: string) => (
    <a key={label} href={to} aria-current={on ? "true" : undefined}
      className={`flex min-h-[44px] items-center border px-3 font-mono text-[11px] uppercase tracking-[0.12em] ${on ? "border-gold bg-gold text-ground" : "border-rule-3 text-ink-2 hover:text-ink"}`}>{label}</a>
  );
  return (
    <div role="group" aria-label="Filter" className="mt-6 flex flex-wrap gap-2">
      {chip("All", !group, href({ group: null, page: 1 }))}
      {NOTICE_GROUPS.map((g) => chip(g, group === g, href({ group: g, page: 1 })))}
    </div>
  );
}
