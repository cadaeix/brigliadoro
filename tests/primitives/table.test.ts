import { describe, it, expect } from "vitest";
import { rollOnTable } from "../../src/primitives/table.js";
import { seededRng, sequenceRng } from "../../src/test-helpers/index.js";
import type { Table } from "../../src/types/index.js";

// A simple d6 table with three ranged entries covering 1-6 fully.
const weather: Table<string> = {
  name: "Weather",
  notation: "1d6",
  entries: [
    { range: [1, 2], item: "clear skies" },
    { range: [3, 4], item: "overcast" },
    { range: [5, 6], item: "storm" },
  ],
};

// d20 table with uneven ranges (common for rarity)
const encounter: Table<string> = {
  name: "Wilderness Encounter",
  notation: "1d20",
  entries: [
    { range: [1, 10], item: "nothing" },
    { range: [11, 15], item: "lost traveller" },
    { range: [16, 19], item: "brigands" },
    { range: [20, 20], item: "dragon" },
  ],
};

describe("rollOnTable", () => {
  it("returns the entry whose range contains the roll", () => {
    // sequenceRng: d6 roll of 1 = value 0.0
    const r = rollOnTable(weather, sequenceRng([0.0]));
    expect(r.item).toBe("clear skies");
    expect(r.roll).toBe(1);
    expect(r.table).toBe("Weather");
    expect(r.notation).toBe("1d6");
    expect(r.chain).toHaveLength(1);
  });

  it("maps ranges correctly across all d6 slots", () => {
    // d6: values 0.0, 2/6, 4/6 map to 1, 3, 5
    const cases = [
      { rng: 0.0, roll: 1, item: "clear skies" },
      { rng: 1 / 6, roll: 2, item: "clear skies" },
      { rng: 2 / 6, roll: 3, item: "overcast" },
      { rng: 3 / 6, roll: 4, item: "overcast" },
      { rng: 4 / 6, roll: 5, item: "storm" },
      { rng: 5 / 6, roll: 6, item: "storm" },
    ];
    for (const c of cases) {
      const r = rollOnTable(weather, sequenceRng([c.rng]));
      expect(r.roll).toBe(c.roll);
      expect(r.item).toBe(c.item);
    }
  });

  it("handles uneven ranges on d20", () => {
    // d20: (desired - 1) / 20 gives desired
    const r = rollOnTable(encounter, sequenceRng([19 / 20]));
    expect(r.roll).toBe(20);
    expect(r.item).toBe("dragon");

    const r2 = rollOnTable(encounter, sequenceRng([0.0]));
    expect(r2.roll).toBe(1);
    expect(r2.item).toBe("nothing");

    const r3 = rollOnTable(encounter, sequenceRng([12 / 20]));
    expect(r3.roll).toBe(13);
    expect(r3.item).toBe("lost traveller");
  });

  it("falls back to Math.random when no rng provided", () => {
    const r = rollOnTable(weather);
    expect(["clear skies", "overcast", "storm"]).toContain(r.item);
    expect(r.roll).toBeGreaterThanOrEqual(1);
    expect(r.roll).toBeLessThanOrEqual(6);
  });

  it("is deterministic with seeded PRNG", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const a = rollOnTable(encounter, seededRng(seed));
      const b = rollOnTable(encounter, seededRng(seed));
      expect(a).toEqual(b);
    }
  });

  it("follows rerollOnto chains into subtables", () => {
    const monsters: Table<string> = {
      name: "Monster",
      notation: "1d6",
      entries: [
        { range: [1, 3], item: "kobold" },
        { range: [4, 6], item: "goblin" },
      ],
    };
    const encounterWithMonsterBranch: Table<string> = {
      name: "Nested Encounter",
      notation: "1d6",
      entries: [
        { range: [1, 3], item: "peaceful" },
        { range: [4, 6], item: "monster", rerollOnto: monsters },
      ],
    };
    // Rolls: first 5 (→ monster subtable), second 1 (→ kobold)
    const rng = sequenceRng([4 / 6, 0 / 6]);
    const r = rollOnTable(encounterWithMonsterBranch, rng);
    expect(r.item).toBe("kobold"); // leaf item
    expect(r.chain).toHaveLength(2);
    expect(r.chain[0]!.table).toBe("Nested Encounter");
    expect(r.chain[0]!.item).toBe("monster");
    expect(r.chain[1]!.table).toBe("Monster");
    expect(r.chain[1]!.item).toBe("kobold");
    // Outer table info lifted to top level
    expect(r.table).toBe("Nested Encounter");
    expect(r.notation).toBe("1d6");
  });

  it("uses notation as table name when name is omitted", () => {
    const unnamed: Table<string> = {
      notation: "1d6",
      entries: [{ range: [1, 6], item: "only entry" }],
    };
    const r = rollOnTable(unnamed, sequenceRng([0.0]));
    expect(r.table).toBe("1d6");
  });

  it("throws when roll falls in a gap between ranges", () => {
    const gappy: Table<string> = {
      name: "Gappy",
      notation: "1d6",
      entries: [
        { range: [1, 2], item: "low" },
        { range: [5, 6], item: "high" },
        // 3, 4 uncovered
      ],
    };
    expect(() => rollOnTable(gappy, sequenceRng([2 / 6]))).toThrow(/no entry's range matched/);
  });

  it("throws when a circular rerollOnto exceeds max depth", () => {
    const a: Table<string> = { name: "A", notation: "1d6", entries: [] };
    const b: Table<string> = { name: "B", notation: "1d6", entries: [] };
    a.entries = [{ range: [1, 6], item: "→B", rerollOnto: b }];
    b.entries = [{ range: [1, 6], item: "→A", rerollOnto: a }];
    expect(() => rollOnTable(a, seededRng(1))).toThrow(/reroll chain exceeded/);
  });

  it("supports non-string item types (typed generic)", () => {
    interface Loot {
      kind: "coin" | "gem";
      value: number;
    }
    const lootTable: Table<Loot> = {
      name: "Loot",
      notation: "1d6",
      entries: [
        { range: [1, 4], item: { kind: "coin", value: 10 } },
        { range: [5, 6], item: { kind: "gem", value: 50 } },
      ],
    };
    const r = rollOnTable(lootTable, sequenceRng([0.0]));
    expect(r.item.kind).toBe("coin");
    expect(r.item.value).toBe(10);
  });

  it("handles tables with dice modifiers", () => {
    // 1d6+10 rolls 11-16
    const modded: Table<string> = {
      name: "Modded",
      notation: "1d6+10",
      entries: [
        { range: [11, 13], item: "low" },
        { range: [14, 16], item: "high" },
      ],
    };
    const r = rollOnTable(modded, sequenceRng([0.0]));
    expect(r.roll).toBe(11);
    expect(r.item).toBe("low");
  });
});
