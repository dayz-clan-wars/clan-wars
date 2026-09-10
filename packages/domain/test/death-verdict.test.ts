import { describe, it, expect } from "vitest";
import { classifyDeath, classifyEntityLabel, finishedBy, DEATH_CAUSES, RECENT_HIT_WINDOW_S, FINISH_HP_MAX, type RecentHit } from "../src/death-verdict";

const hit = (o: Partial<RecentHit>): RecentHit => ({ attackerType: "infected", attackerLabel: "Infected", secondsBeforeDeath: 10, victimHp: 50, ...o });
const plain = { mechanism: "died", energy: 500, water: 500, bleedSources: 0 };

describe("classifyEntityLabel", () => {
  it("names wolves and bears, groups the rest of the animals", () => {
    expect(classifyEntityLabel("Animal_CanisLupus_Grey")).toBe("wolf");
    expect(classifyEntityLabel("Animal_UrsusArctos")).toBe("bear");
    expect(classifyEntityLabel("Animal_CapreolusCapreolus")).toBe("animal");
    expect(classifyEntityLabel("Zmb_Male_Farmer")).toBeNull();
    expect(classifyEntityLabel(null)).toBeNull();
  });
});

describe("classifyDeath: a stated mechanism passes through", () => {
  it.each(["pvp", "suicide", "bled_out", "drowned", "environment", "infected", "animal", "wolf", "bear", "fall", "vehicle"])("%s", (m) => {
    // Even with every underlying condition present: the mechanism explains its own side-effects.
    expect(classifyDeath({ mechanism: m, energy: 0, water: 0, bleedSources: 2 }, [hit({})], [])).toBe(m);
  });
});

describe("classifyDeath: a bare `died` is inferred from the two minutes before it", () => {
  it("a fall that took HP to zero is a fall, whatever else was going on", () => {
    expect(classifyDeath({ ...plain, energy: 0 }, [hit({ attackerType: "environment", attackerLabel: "FallDamageHealth", victimHp: 0 })], [])).toBe("fall");
  });
  it("no food is starvation, no water is dehydration; food first", () => {
    expect(classifyDeath({ ...plain, energy: 0 }, [], [])).toBe("starvation");
    expect(classifyDeath({ ...plain, water: 0.5 }, [], [])).toBe("dehydration");
    expect(classifyDeath({ ...plain, energy: 1, water: 0 }, [], [])).toBe("starvation");
  });
  it("infected hits plus bleeding, a knockout, or terminal HP is a mauling", () => {
    expect(classifyDeath({ ...plain, bleedSources: 1 }, [hit({})], [])).toBe("mauled");
    expect(classifyDeath(plain, [hit({})], [{ secondsBeforeDeath: 30, disconnecting: false }])).toBe("mauled");
    expect(classifyDeath(plain, [hit({ victimHp: 0.4 })], [])).toBe("mauled");
  });
  it("⚠️ terminal HP must come from an INFECTED hit — a player's shot at ~0 HP is not corroboration", () => {
    expect(classifyDeath(plain, [hit({ attackerType: "player", attackerLabel: null, victimHp: 0 }), hit({ victimHp: 80 })], [])).toBe("died");
  });
  it("infected hits alone, with nothing to corroborate, stay `died`", () => {
    expect(classifyDeath(plain, [hit({ victimHp: 80 })], [])).toBe("died");
  });
  it("bleeding after any hit is bled out", () => {
    expect(classifyDeath({ ...plain, bleedSources: 1 }, [hit({ attackerType: "environment", attackerLabel: "Fence", victimHp: 60 })], [])).toBe("bled_out");
  });
  it("the window is closed: a hit outside it, or after the death, is not evidence", () => {
    expect(classifyDeath({ ...plain, bleedSources: 1 }, [hit({ secondsBeforeDeath: RECENT_HIT_WINDOW_S + 1 })], [])).toBe("died");
    expect(classifyDeath({ ...plain, bleedSources: 1 }, [hit({ secondsBeforeDeath: -1 })], [])).toBe("died");
  });
  it("healthy, unhit, unexplained: `died`, as the log wrote it", () => {
    expect(classifyDeath(plain, [], [])).toBe("died");
    expect(classifyDeath({ mechanism: "died", energy: null, water: null, bleedSources: null }, [], [])).toBe("died");
  });
});

describe("DEATH_CAUSES is the whole vocabulary the kills column may hold", () => {
  it("contains every verdict", () => {
    for (const c of ["pvp", "suicide", "bled_out", "drowned", "environment", "explosion", "infected", "animal", "wolf", "bear", "fall", "vehicle", "starvation", "dehydration", "mauled", "finished", "died"]) {
      expect(DEATH_CAUSES.has(c), c).toBe(true);
    }
  });
});

describe("finishedBy: a bare death credited to the player who shot them", () => {
  const shot = (o: Partial<RecentHit>): RecentHit => hit({ attackerType: "player", attackerLabel: null, attackerId: "K", weapon: "DMR", distanceM: 40, ...o });
  it("the last player hit left them at FINISH_HP_MAX or below, nothing else hurt them after: credited", () => {
    expect(finishedBy([shot({ secondsBeforeDeath: 103, victimHp: 11.3 })], [])?.attackerId).toBe("K");
    expect(finishedBy([shot({ secondsBeforeDeath: 50, victimHp: 70 }), shot({ secondsBeforeDeath: 24, victimHp: FINISH_HP_MAX })], [])?.secondsBeforeDeath).toBe(24);
  });
  it("a knockout after the hit credits it even from higher HP", () => {
    expect(finishedBy([shot({ secondsBeforeDeath: 24, victimHp: 60 })], [{ secondsBeforeDeath: 10, disconnecting: false }])?.attackerId).toBe("K");
    expect(finishedBy([shot({ secondsBeforeDeath: 24, victimHp: 60 })], [{ secondsBeforeDeath: 30, disconnecting: false }])).toBeNull(); // the knockout came first
  });
  it("not credited: high HP and no knockout; a hit outside the window; an unknown attacker", () => {
    expect(finishedBy([shot({ secondsBeforeDeath: 24, victimHp: 60 })], [])).toBeNull();
    expect(finishedBy([shot({ secondsBeforeDeath: RECENT_HIT_WINDOW_S + 1, victimHp: 5 })], [])).toBeNull();
    expect(finishedBy([shot({ secondsBeforeDeath: 24, victimHp: 5, attackerId: null })], [])).toBeNull();
  });
  it("⚠️ anything but a player hurting them AFTER the last shot breaks the credit — the infected or the fall finished it", () => {
    expect(finishedBy([shot({ secondsBeforeDeath: 60, victimHp: 5 }), hit({ secondsBeforeDeath: 20, victimHp: 3 })], [])).toBeNull();
    expect(finishedBy([hit({ secondsBeforeDeath: 90, victimHp: 80 }), shot({ secondsBeforeDeath: 60, victimHp: 5 })], [])?.attackerId).toBe("K"); // before it is fine
  });
  it("⚠️ a burst logs several hits in one second: the lowest HP is the last of them", () => {
    // As logged for YrJustBad on 2026-09-01: four hits at the same second, 56 → 38 → 21 → 3.6.
    const burst = [56.1, 38.6, 21.1, 3.6].map((hp) => shot({ secondsBeforeDeath: 87, victimHp: hp }));
    expect(finishedBy(burst, [])?.victimHp).toBe(3.6);
    expect(finishedBy([...burst].reverse(), [])?.victimHp).toBe(3.6);
  });
  it("the credit goes to the LAST player to hit them, with that hit's weapon", () => {
    const f = finishedBy([shot({ secondsBeforeDeath: 80, victimHp: 30, attackerId: "K1", weapon: "KA-74" }), shot({ secondsBeforeDeath: 20, victimHp: 4, attackerId: "K2", weapon: "SCR 17" })], []);
    expect(f).toMatchObject({ attackerId: "K2", weapon: "SCR 17" });
  });
});
