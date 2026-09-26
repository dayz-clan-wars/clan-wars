/** What the model reads (spec §5.1). Every string here that a player wrote went through `PlayerTexts`. */

export type ClanRef = { name: string; tag: string };

export type ClanWeek = ClanRef & {
  status: "active" | "dormant";
  isStaff: boolean;
  pitch: string | null;
  members: number;
  weekPoints: number;
  weekRaids: number;
  timesRaidedThisWeek: number;
  seasonPoints: number;
  seasonRaids: number;
  flagDown: boolean;
};

export type RaidStory = {
  at: string;
  /** Precomputed "Thursday 16:33 UTC" for `at`; the model must never compute a weekday itself. */
  when: string;
  raider: string;
  raiderClan: ClanRef | null;
  victimClan: ClanRef;
  points: number;
  kind: "online" | "offline";
  victimsOnline: number;
  /** Offline raids only: minutes until anyone from the victim clan connected. */
  minutesUntilVictimLogin: number | null;
  /** Minutes until the victim clan raised its flag again; null = never (before the next raid on it). */
  reRaisedAfterMinutes: number | null;
};

export type FlagEventKind = "founded" | "activated" | "dormant" | "revived" | "disbanded";
export type FlagEvent = { clan: ClanRef; kind: FlagEventKind; at: string; when: string };

export type FfPair = {
  clan: ClanRef; killer: string; victim: string; count: number; weapons: string[];
  first: string; firstWhen: string; last: string; lastWhen: string;
};
export type ClanVsClan = { killerClan: ClanRef; victimClan: ClanRef; kills: number };

export type PlayerLine = { gamertag: string; clan: ClanRef | null; value: number };
export type ShotLine = { gamertag: string; clan: ClanRef | null; victim: string; metres: number; weapon: string | null };
export type OddDeath = { gamertag: string; cause: string; at: string; when: string };

export type BountyStory = {
  target: string;
  reason: string | null;
  placedAt: string;
  placedWhen: string;
  status: "open" | "claimed" | "expired" | "revoked";
  claimer: string | null;
  hoursToClaim: number | null;
  claimMetres: number | null;
};

export type KothStory = { location: string; at: string; when: string; winner: string | null; top: { gamertag: string; kills: number }[] };
export type AirdropStory = { location: string; at: string; when: string; state: string };

export type Storyline = { title: string; players: string[]; clans: string[]; status: string; openQuestions: string[] };
export type PreviousEpisode = { title: string; storylines: Storyline[] };

export type StoryContext = {
  week: { start: string; end: string; season: number; episode: number };
  clans: ClanWeek[];
  raids: RaidStory[];
  flagEvents: FlagEvent[];
  friendlyFire: FfPair[];
  clanBeefs: ClanVsClan[];
  players: { topKillers: PlayerLine[]; mostDeaths: PlayerLine[]; longestShots: ShotLine[]; oddDeaths: OddDeath[] };
  bounties: BountyStory[];
  koth: KothStory[];
  airdrops: AirdropStory[];
  previous: PreviousEpisode | null;
};
