import { Page, kicker } from "@/app/components/ui";

/** Shown while a gated page's data is fetched: the page column with one status line, no spinner to spin. */
export default function Loading() {
  return (
    <Page>
      <p role="status" className={`${kicker} px-5 pt-8 lg:px-8 lg:pt-12`}>Loading…</p>
    </Page>
  );
}
