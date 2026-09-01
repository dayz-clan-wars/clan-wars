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
  ) {}

  private async getJson(path: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Nitrado ${res.status} for ${path}`);
    return res.json() as Promise<Record<string, any>>;
  }

  /** Filename time is SERVER-LOCAL; treated as UTC here purely as a comparable number. */
  private parseFilenameTs(name: string): number | null {
    const m = FILENAME_RE.exec(name);
    if (!m) return null;
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
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
    files.sort((a, b) => a.localTimestampMs - b.localTimestampMs);
    return files;
  }

  /** Two steps: the API returns a signed URL, then the bytes come from there. */
  async downloadFile(filePath: string): Promise<string> {
    const dl = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`,
    );
    const url = dl?.data?.token?.url;
    if (!url) throw new Error("Nitrado: no download url returned");
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Nitrado download ${res.status}`);
    return res.text();
  }
}
