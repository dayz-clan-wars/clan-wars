/** A short cross-promo caption, not the transcript (KOTH). ⚠️ No em dash: the KOTH caption had one. */
export function buildFacebookCaption(o: { code: string; subtitle: string; youtubeVideoId: string; discordInvite: string }): string {
  return [
    `\u{1F399}\u{FE0F} The Bloodbag and Painkiller Show: Clan Wars ${o.code} · ${o.subtitle}`,
    "This week in Clan Wars: the raids, the grudges and the friendly fire.",
    `\u{25B6}\u{FE0F} Full episode on YouTube: https://youtu.be/${o.youtubeVideoId}`,
    `\u{1F4AC} Join the war: https://${o.discordInvite}`,
  ].join("\n\n");
}
