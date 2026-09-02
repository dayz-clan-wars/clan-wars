/** One ADM file as Nitrado describes it. */
export type AdmFileRef = {
  path: string;
  name: string;
  /** Parsed from the filename, which carries SERVER-LOCAL time. Unparseable files are dropped to preserve oldest-first ordering invariant. */
  localTimestampMs: number;
  /** Nitrado's own mtime, in UTC ms. 0 when the API omitted it — see the derivation guard. */
  modifiedAtMs: number;
};

const API_BASE = "https://api.nitrado.net";
const FILENAME_RE = /DayZServer_X1_x64_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/u;

/**
 * Reads ADM files from a Nitrado game server.
 *
 * `fetchFn` is injected rather than calling global fetch, so tests exercise
 * every branch — including the two-step download — with no network.
 */
export class NitradoClient {
  constructor(
    private readonly token: string,
    private readonly serviceId: number,
    private readonly fetchFn: typeof fetch = fetch,
    /**
     * ⚠️ Per-request deadline. Without one, a stalled connection blocks the
     * ENTIRE sequential sweep — every other server included — until undici's
     * ~300s default fires, with no log line while it hangs.
     */
    private readonly timeoutMs: number = 30_000,
  ) {}

  // ⚠️ Nitrado answers some errors with HTTP 200 and status:"error". Checking
  // res.ok alone reports those as success. Both getJson and postJson route
  // through this single check so the guard can't drift between the two.
  private assertSuccess(body: Record<string, any>, path: string): void {
    if (body.status !== "success") {
      throw new Error(`Nitrado ${path} returned status=${body.status}: ${body.message ?? "no message"}`);
    }
  }

  private async getJson(path: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Nitrado ${res.status} for ${path}`);
    const body = (await res.json()) as Record<string, any>;
    this.assertSuccess(body, path);
    return body;
  }

  private async postJson(path: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Nitrado ${res.status} for ${path}`);
    const body = (await res.json()) as Record<string, any>;
    this.assertSuccess(body, path);
    return body;
  }

  /** Filename time is SERVER-LOCAL; treated as UTC here purely as a comparable number. */
  private parseFilenameTs(name: string): number | null {
    const m = FILENAME_RE.exec(name);
    if (!m) return null;
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  }

  /**
   * Where this server's mission reads its object-spawner files from.
   *
   * ⚠️ NOT under `game_specific.path`. That is the `noftp` tree and exposes
   * only `config/`; the mission lives in the sibling `ftproot` tree, and
   * `paths_available` is null, so nothing hands this path over directly. It is
   * composed from three fields of the same `/gameservers` response
   * `listAdmFiles` already reads:
   *
   *     /games/{username}/ftproot/{game}_missions/{mission}/custom
   *
   * ⚠️ `username` (ni11558038_4), NOT the Nitrado service id (19831378). They
   * are different values, which is why this cannot be derived from the service
   * id the sweep already holds and has to come from the API.
   *
   * Derived per server on every sweep rather than stored: a stored path goes
   * stale the moment an operator changes the mission or the map, and a stale
   * path means uploading into a directory the server no longer reads —
   * succeeding silently, which is the failure this exists to prevent. One GET
   * per server per sweep is cheaper than that class of bug.
   *
   * Throws on any missing field. A composed path with a hole in it is
   * syntactically fine and points somewhere real-looking and wrong, and
   * uploadFile reports success for a write the game never reads.
   */
  async missionCustomDir(): Promise<string> {
    const gs = (await this.getJson(`/services/${this.serviceId}/gameservers`))?.data?.gameserver;
    const username = gs?.username;
    const game = gs?.game;
    const mission = gs?.settings?.config?.mission;
    if (!username) throw new Error("Nitrado: gameserver has no username, cannot locate the mission directory");
    if (!game) throw new Error("Nitrado: gameserver has no game, cannot locate the mission directory");
    if (!mission) throw new Error("Nitrado: gameserver has no settings.config.mission, cannot locate the mission directory");
    return `/games/${username}/ftproot/${game}_missions/${mission}/custom`;
  }

  async listAdmFiles(): Promise<AdmFileRef[]> {
    const gs = await this.getJson(`/services/${this.serviceId}/gameservers`);
    const base = gs?.data?.gameserver?.game_specific?.path;
    if (!base) throw new Error("Nitrado: could not resolve gameserver path");

    const listing = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(base + "config")}`,
    );
    const entries: any[] = listing?.data?.entries ?? [];
    const files: AdmFileRef[] = entries
      .filter((e) => {
        if (!(typeof e.name === "string" && e.name.endsWith(".ADM") && e.path)) return false;
        const ts = this.parseFilenameTs(e.name);
        if (ts === null) {
          console.warn(`Nitrado: dropping ADM file with unparseable name: ${e.name}`);
          return false;
        }
        return true;
      })
      .map((e) => ({
        path: e.path as string,
        name: e.name as string,
        localTimestampMs: this.parseFilenameTs(e.name)!,
        // ⚠️ Faithfully report a missing mtime as 0. The derivation EXCLUDES
        // zeros; silently substituting "now" here would corrupt the offset.
        modifiedAtMs: (e.modified_at ?? 0) * 1000,
      }));

    // Oldest-first. Ordering is load-bearing: the tick backfills in this order
    // and a file's timestamps depend on every file before it.
    //
    // ⚠️ HAZARD, knowingly unfixed: `localTimestampMs` comes from the
    // filename, which carries SERVER-LOCAL time. If a server's local clock
    // steps BACKWARDS (a DST transition, an operator changing the timezone),
    // the file created after the step sorts BEFORE its predecessor. The
    // genuinely live file is then treated by the tick as an old file, marked
    // `complete` and skipped forever, while the stale one is re-downloaded
    // every tick — the symptom is a server that silently stops ingesting after
    // a backwards clock step. Accepted because the production servers run
    // fixed UTC+4/+7 with no DST, and cross-checking Nitrado's mtime would
    // introduce a worse hazard that fires on routine re-uploads.
    files.sort((a, b) => a.localTimestampMs - b.localTimestampMs);
    return files;
  }

  /**
   * What the game server currently reports about one file, or null when it is
   * not there. Used to notice that something other than us rewrote it.
   *
   * ⚠️ `modified_at` is the GAME SERVER's clock, in seconds. Do not compare it
   * to a timestamp of ours: those servers run fixed UTC+4/+7 and any offset
   * would read as permanent drift. Compare it only against a value previously
   * returned by this method.
   *
   * ⚠️ A directory that does not exist and a file that does not exist both
   * arrive here as "no entry". Returning null for either is deliberate: the
   * caller's repair for both is the same upload.
   */
  async statFile(remoteDir: string, fileName: string): Promise<{ size: number; modifiedAtMs: number } | null> {
    const listing = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(remoteDir)}`,
    );
    const entries: any[] = listing?.data?.entries ?? [];
    const entry = entries.find((e) => e?.name === fileName && e?.type === "file");
    if (!entry) return null;
    // ⚠️ A missing size or mtime must not read as 0 — that is a real value
    // here and would look like drift on every tick. Treat an entry we cannot
    // measure as no entry, so the caller re-uploads once and re-observes.
    if (typeof entry.size !== "number" || typeof entry.modified_at !== "number") return null;
    return { size: entry.size, modifiedAtMs: entry.modified_at * 1000 };
  }

  /** Two steps: the API returns a signed URL, then the bytes come from there. */
  async downloadFile(filePath: string): Promise<string> {
    const dl = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`,
    );
    const url = dl?.data?.token?.url;
    if (!url) throw new Error("Nitrado: no download url returned");
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`Nitrado download ${res.status}`);
    return res.text();
  }

  /**
   * Write a file to the game server, via Nitrado's two-step token flow.
   *
   * ⚠️ Step two is NOT a normal API call: the URL comes from step one, the
   * token goes in a bare `token` header (not Authorization), and the body is
   * sent as application/binary. Sending it as JSON with a bearer silently
   * fails.
   */
  async uploadFile(remoteDir: string, fileName: string, content: string): Promise<void> {
    const json = await this.postJson(`/services/${this.serviceId}/gameservers/file_server/upload`, {
      path: remoteDir,
      file: fileName,
    });
    const url = json.data?.token?.url;
    const token = json.data?.token?.token;
    if (!url) throw new Error(`Nitrado upload: missing token url for ${remoteDir}/${fileName}`);
    // A missing token would otherwise degrade silently into a bare 403 from
    // step two — throw here so the failure is distinguishable at 3am.
    if (!token) throw new Error(`Nitrado upload: missing token for ${remoteDir}/${fileName}`);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/binary", token },
      body: content,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Nitrado upload failed ${res.status} for ${remoteDir}/${fileName}`);

    // ⚠️ res.ok alone is not enough on THIS step either. Nitrado answers some
    // errors with HTTP 200 and status:"error"; if that happened here the
    // upload would resolve, supply-tick would advance the stored hash, and the
    // file on the server would diverge from the database permanently with
    // nothing ever retrying it.
    //
    // ⚠️ HONEST AMBIGUITY: nobody has verified what this signed-URL endpoint
    // actually returns on success — it may well be an empty body, and the
    // working deployment depends on that staying a success. So this is
    // deliberately narrow: throw ONLY when the body parses as JSON AND carries
    // a `status` that is not "success". An empty or non-JSON body stays a
    // success. If we ever observe a real success envelope here, tighten it.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined; // Not JSON — nothing to assert against.
    }
    if (parsed && typeof parsed === "object" && "status" in parsed) {
      const body = parsed as Record<string, any>;
      if (body.status !== "success") {
        throw new Error(
          `Nitrado upload returned status=${body.status} for ${remoteDir}/${fileName}: ${body.message ?? "no message"}`,
        );
      }
    }
  }
}
