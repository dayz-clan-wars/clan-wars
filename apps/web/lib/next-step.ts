import { LINK_EMOTES, JOIN_PRESENCE_RADIUS_M } from "@factions/domain";

/**
 * /me's next-step strip (App Review §01). The page shows status; this says
 * what to do about it. One state, picked in this order: a ceremony waiting
 * → a link challenge open → not linked → pending in a clan → an invite or
 * a request open → no clan → in a clan (nothing to say; the strip is hidden).
 *
 * Pure, so test/next-step.test.ts can walk the order without a database.
 */
export type NextStepInput = {
  linked: boolean;
  challengeOpen: boolean;
  inClan: boolean;
  pending: { name: string } | null;
  ceremonyId: number | null;
  invites: { id: number; clanName: string }[];
  requests: { clanName: string }[];
};

export type NextStep = {
  kicker: string;
  title: string;
  body: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
  /** The guide chapter's key in lib/guide-links, when one explains this step. */
  guide?: "/link" | "/claim/[ceremony]" | "/clan" | "/clans" | "/base";
};

export function nextStepFor(v: NextStepInput): NextStep | null {
  if (v.ceremonyId !== null) {
    return {
      kicker: "Next", title: "Found the clan",
      body: "You and your friends raised the neutral flag together. Any one of you can name the clan, pick its flag and become leader — until the ceremony expires.",
      primary: { label: "Found the clan", href: `/claim/${v.ceremonyId}` }, guide: "/claim/[ceremony]",
    };
  }
  if (v.challengeOpen) {
    return {
      kicker: "Next · step 3 of 3", title: "Prove it's you",
      body: `Your link challenge is open. In game, perform the ${LINK_EMOTES} emotes in order; the page checks every few seconds.`,
      primary: { label: "Open the challenge", href: "/link" }, guide: "/link",
    };
  }
  if (!v.linked) {
    return {
      kicker: "Next · step 2 of 3", title: "Link your character",
      body: `Name the gamertag you play under, then prove it with ${LINK_EMOTES} emotes in game. Your clan, base and map hang off this.`,
      primary: { label: "Link it", href: "/link" }, guide: "/link",
    };
  }
  if (v.pending) {
    return {
      kicker: "Next", title: "Go stand at the base",
      body: `You are pending in ${v.pending.name}. Stand within ${JOIN_PRESENCE_RADIUS_M} m of the clan's base in game and the server log makes you a full member.`,
      primary: { label: "The map", href: "/map" }, secondary: { label: "The roster", href: "/clan" }, guide: "/clan",
    };
  }
  if (v.inClan) return null;
  if (v.invites.length > 0) {
    const first = v.invites[0]!;
    const more = v.invites.length - 1;
    return {
      kicker: "Next", title: "Get into a clan",
      body: `You are linked and on your own. ${first.clanName} has invited you${more > 0 ? ` (and ${more} more)` : ""}; or browse the clans, or raise a flag with two friends and found your own.`,
      primary: { label: "Accept invite", href: "#invites" }, secondary: { label: "Browse clans", href: "/clans" }, guide: "/clans",
    };
  }
  if (v.requests.length > 0) {
    return {
      kicker: "Next", title: "Waiting on a clan",
      body: `Your request to join ${v.requests[0]!.clanName} is with their officers. Meanwhile you can declare a solo base at a pole you have raised at.`,
      primary: { label: "Your base", href: "/base" }, secondary: { label: "Browse clans", href: "/clans" }, guide: "/base",
    };
  }
  return {
    kicker: "Next", title: "Get into a clan",
    body: "You are linked and on your own. Browse the clans that are recruiting, or raise a flag at a pole with two friends and found your own. Solo, you can still declare a base.",
    primary: { label: "Browse clans", href: "/clans" }, secondary: { label: "Your base", href: "/base" }, guide: "/clans",
  };
}
