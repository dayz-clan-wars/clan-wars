import { describe, it, expect } from "vitest";
import { classifyDeath, classifyEntityLabel, DEATH_CAUSES, RECENT_HIT_WINDOW_S, type RecentHit } from "../src/death-verdict";

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
    for (const c of ["pvp", "suicide", "bled_out", "drowned", "environment", "infected", "animal", "wolf", "bear", "fall", "vehicle", "starvation", "dehydration", "mauled", "died"]) {
      expect(DEATH_CAUSES.has(c), c).toBe(true);
    }
  });
});
