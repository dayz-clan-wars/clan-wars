import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { GROUP_COLORS, TOAST } from "@/lib/achievements-copy";
import { AchievementBadge } from "@/app/components/achievement-badge";
import { shareCardLine, shareCardParams } from "@/lib/achievement-share";

export const SHARE_CARD = { width: 1200, height: 630, ground: "#050505", ink: "#e8e2d4", ink2: "#b5afa4", muted: "#8a857c", gold: "#d9a03c", frame: "#0b0b0a", rule: "#2a2825" } as const;

/**
 * ⚠️ Read from `process.cwd()/public`, which is `apps/web` under `next dev`
 * and, in the Docker image, `/app/apps/web` — the standalone `server.js`
 * chdirs to its own directory first, and the Dockerfile copies `public/`
 * there by hand. A path built any other way works locally and 500s in
 * production, where nothing else fetches this file.
 */
const asset = (...p: string[]) => readFile(join(process.cwd(), "public", ...p));
let fontData: Promise<Buffer> | undefined;
let markData: Promise<string> | undefined;
const font = () => (fontData ??= asset("fonts", "ArchivoBlack.ttf"));
const mark = () => (markData ??= asset("mark.png").then((b) => `data:image/png;base64,${b.toString("base64")}`));

/** `#d4623a` at an alpha, as rgba() — the renderer reads that where an 8-digit hex is not guaranteed. */
function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The share card (design hand-off §05): 1200×630, the badge at left on a
 * glow in the group's colour, kicker / name / description / who-and-when at
 * right, the mark and the domain in the footer bar. Reference render:
 * docs/direction/achievements-share-card-champions.png.
 *
 * The owner line comes from the query (`gamertag`, `tag`, `earned`), each
 * optional and each clipped (lib/achievement-share.ts) — the card is a
 * picture of what the wall already shows publicly, never a lookup. An
 * unknown key is a 404, not a blank card.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const a = ACHIEVEMENT_BY_KEY[key as AchievementKey];
  if (!a) return new Response("Not found", { status: 404 });
  const colour = GROUP_COLORS[a.group];
  const who = shareCardLine(shareCardParams(new URL(req.url).searchParams));
  const [data, markSrc] = await Promise.all([font(), mark()]);
  const S = SHARE_CARD;
  const gridLine = "rgba(255,255,255,0.03)";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: S.ground, fontFamily: "Archivo Black", color: S.ink }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", position: "relative", backgroundImage: `radial-gradient(circle at 25% 50%, ${rgba(colour, 0.22)} 0%, ${rgba(colour, 0)} 55%), linear-gradient(${gridLine} 1px, transparent 1px), linear-gradient(90deg, ${gridLine} 1px, transparent 1px)`, backgroundSize: "100% 100%, 70px 70px, 70px 70px" }}>
          <div style={{ display: "flex", width: 400, height: 400, marginLeft: 72 }}>
            <AchievementBadge achievementKey={a.key} group={a.group} state="unlocked" size={400} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 68, marginRight: 60, flex: 1 }}>
            <div style={{ fontSize: 20, letterSpacing: 5, textTransform: "uppercase", color: colour }}>{TOAST.kicker(a.group).toUpperCase()}</div>
            <div style={{ fontSize: 80, lineHeight: 1, letterSpacing: -1, textTransform: "uppercase", marginTop: 18, color: S.ink }}>{a.name}</div>
            <div style={{ fontSize: 28, marginTop: 22, color: S.ink2 }}>{a.description}</div>
            {who && <div style={{ fontSize: 20, letterSpacing: 4, textTransform: "uppercase", marginTop: 40, color: S.muted }}>{who}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72, padding: "0 36px", background: S.frame, borderTop: `2px solid ${S.rule}` }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markSrc} width={36} height={36} alt="" />
            <div style={{ fontSize: 22, letterSpacing: 2, textTransform: "uppercase", marginLeft: 16, color: S.ink }}>CLAN WARS · LIVONIA</div>
          </div>
          <div style={{ fontSize: 20, letterSpacing: 4, textTransform: "uppercase", color: S.gold }}>DAYZCLANWARS.COM</div>
        </div>
      </div>
    ),
    { width: S.width, height: S.height, fonts: [{ name: "Archivo Black", data, weight: 400, style: "normal" }], headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
