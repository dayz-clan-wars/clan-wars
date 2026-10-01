import { redirect } from "next/navigation";

/** /live has no page of its own: it opens on the Kills tab. */
export const dynamic = "force-dynamic";

export default function LiveIndex() {
  redirect("/live/kills");
}
