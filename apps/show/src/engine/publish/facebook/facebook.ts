import fs from "node:fs";

const GRAPH = "https://graph.facebook.com/v21.0";

// KOTH `bot/src/facebook/facebook.js` at a5ef8e7, `uploadPageVideo` ported to TS (behavior
// unchanged). `longLivedPageToken` is not ported: the Page token already exists in the
// KOTH `.env` and is reused (task 6 brief).
export async function uploadPageVideo(o: {
  pageId: string;
  accessToken: string;
  filePath: string;
  description: string;
  fetchImpl?: typeof fetch;
  fsImpl?: { readFileSync(p: string): Buffer };
}): Promise<string> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const fsImpl = o.fsImpl ?? fs;
  const bytes = fsImpl.readFileSync(o.filePath);
  const form = new FormData();
  form.append("access_token", o.accessToken);
  form.append("description", o.description ?? "");
  form.append("source", new Blob([new Uint8Array(bytes)]), "episode.mp4");
  const res = await fetchImpl(`${GRAPH}/${o.pageId}/videos`, { method: "POST", body: form });
  const j = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!res.ok || !j?.id) throw new Error(`Facebook video upload failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j.id;
}

/** A crash between upload and the row write left this video behind (spec §8.3); the caption carries the YouTube link. */
export async function findPageVideoByLink(o: { pageId: string; accessToken: string; link: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const q = new URLSearchParams({ fields: "id,description", limit: "10", access_token: o.accessToken });
  const res = await (o.fetchImpl ?? fetch)(`${GRAPH}/${o.pageId}/videos?${q}`);
  const j = (await res.json().catch(() => null)) as { data?: { id: string; description?: string }[] } | null;
  if (!res.ok) throw new Error(`Facebook /videos failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j?.data?.find((v) => v.description?.includes(o.link))?.id ?? null;
}
