import fs from "node:fs";

export type Privacy = "public" | "unlisted" | "private";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus";
const GAMING_CATEGORY_ID = "20";
const STATUS_URL = "https://www.googleapis.com/youtube/v3/videos?part=status&id=";
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 6 * 60_000;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// KOTH `bot/src/youtube/youtube.js` at a5ef8e7, ported to TS.
export async function accessTokenFromRefresh(o: { clientId: string; clientSecret: string; refreshToken: string; fetchImpl?: typeof fetch }): Promise<string> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: o.clientId,
    client_secret: o.clientSecret,
    refresh_token: o.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !j?.access_token) throw new Error(`YouTube token refresh failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j.access_token;
}

// ⚠️ `privacy` is required here (KOTH defaulted to "public"): this app always uploads unlisted first.
export async function uploadVideo(o: {
  accessToken: string;
  filePath: string;
  title: string;
  description: string;
  privacy: Privacy;
  fetchImpl?: typeof fetch;
  fsImpl?: { readFileSync(p: string): Buffer };
}): Promise<string> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const fsImpl = o.fsImpl ?? fs;
  const bytes = fsImpl.readFileSync(o.filePath);
  const metadata = {
    snippet: { title: o.title, description: o.description, categoryId: GAMING_CATEGORY_ID },
    status: { privacyStatus: o.privacy },
  };
  // 1) open the resumable session
  const init = await fetchImpl(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/*",
      "X-Upload-Content-Length": String(bytes.length),
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) {
    const j = await init.json().catch(() => null);
    throw new Error(`YouTube resumable session init failed ${init.status}: ${JSON.stringify(j ?? {})}`);
  }
  const sessionUri = init.headers.get("location") || init.headers.get("Location");
  if (!sessionUri) throw new Error("YouTube resumable session: no Location header");

  // 2) upload the bytes
  const put = await fetchImpl(sessionUri, {
    method: "PUT",
    headers: { "Content-Type": "video/*" },
    body: new Uint8Array(bytes),
  });
  const j = (await put.json().catch(() => null)) as { id?: string } | null;
  if (!put.ok || !j?.id) throw new Error(`YouTube upload failed ${put.status}: ${JSON.stringify(j ?? {})}`);
  return j.id;
}

/**
 * Poll videos.list until the video reports uploadStatus 'processed', or until maxWaitMs elapses.
 * Returns true if processed, false on timeout / terminal failure / any API error. Never throws.
 * Requires an access token with the youtube.readonly (or youtube) scope.
 */
export async function waitForVideoProcessed(o: {
  accessToken: string;
  videoId: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const intervalMs = o.intervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = o.maxWaitMs ?? MAX_WAIT_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const deadline = now() + maxWaitMs;
  for (;;) {
    try {
      const res = await fetchImpl(`${STATUS_URL}${encodeURIComponent(o.videoId)}`, {
        headers: { Authorization: `Bearer ${o.accessToken}` },
      });
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { items?: { status?: { uploadStatus?: string } }[] } | null;
        const status = j?.items?.[0]?.status?.uploadStatus;
        if (status === "processed") return true;
        if (status === "failed" || status === "rejected") return false;
      }
    } catch {
      // best-effort: treat as not-ready, keep polling until the deadline
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const API = "https://www.googleapis.com/youtube/v3";

async function ytJson(fetchImpl: typeof fetch, what: string, url: string, init: RequestInit): Promise<any> {
  const res = await fetchImpl(url, init);
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`YouTube ${what} failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j;
}
const auth = (accessToken: string, withBody = false): Record<string, string> =>
  withBody ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" } : { Authorization: `Bearer ${accessToken}` };

/** Needs the `youtube` scope (spec §9.1). ⚠️ videos.update replaces the whole `status` part; only privacy is set. */
export async function setPrivacy(o: { accessToken: string; videoId: string; privacy: Privacy; fetchImpl?: typeof fetch }): Promise<void> {
  await ytJson(o.fetchImpl ?? fetch, "videos.update", `${API}/videos?part=status`, {
    method: "PUT", headers: auth(o.accessToken, true), body: JSON.stringify({ id: o.videoId, status: { privacyStatus: o.privacy } }),
  });
}

export async function playlistHas(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<boolean> {
  const q = new URLSearchParams({ part: "id", playlistId: o.playlistId, videoId: o.videoId });
  const j = await ytJson(o.fetchImpl ?? fetch, "playlistItems.list", `${API}/playlistItems?${q}`, { headers: auth(o.accessToken) });
  return (j?.items?.length ?? 0) > 0;
}

export async function addToPlaylist(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<void> {
  await ytJson(o.fetchImpl ?? fetch, "playlistItems.insert", `${API}/playlistItems?part=snippet`, {
    method: "POST", headers: auth(o.accessToken, true),
    body: JSON.stringify({ snippet: { playlistId: o.playlistId, resourceId: { kind: "youtube#video", videoId: o.videoId } } }),
  });
}

/**
 * The upload that a crash between `uploadVideo` and the row write left behind (spec §8.3):
 * the newest 50 uploads, which include unlisted ones, matched on the exact title AND
 * description. ⚠️ The title alone is not enough: a `--force` cut often keeps the subtitle, and
 * adopting the old cut's video would publish what nobody reviewed. The description is the
 * transcript, so it tells two cuts apart with no visible marker in public text.
 */
export async function findUploadByTitle(o: { accessToken: string; title: string; description: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const ch = await ytJson(fetchImpl, "channels.list", `${API}/channels?part=contentDetails&mine=true`, { headers: auth(o.accessToken) });
  const uploads: string | undefined = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube channels.list: no uploads playlist for this token's channel");
  const q = new URLSearchParams({ part: "snippet", maxResults: "50", playlistId: uploads });
  const items = await ytJson(fetchImpl, "playlistItems.list", `${API}/playlistItems?${q}`, { headers: auth(o.accessToken) });
  const hit = (items?.items ?? []).find((i: any) => i?.snippet?.title === o.title && i?.snippet?.description === o.description);
  return hit?.snippet?.resourceId?.videoId ?? null;
}
