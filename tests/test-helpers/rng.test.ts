import { describe, it, expect } from "vitest";
import { seededRng, sequenceRng } from "../../src/test-helpers/index.js";
import { rollDice } from "../../src/primitives/dice.js";

describe("seededRng", () => {
  it("produces the same sequence for the same seed", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = seededRng(1);
    const b = seededRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("stays in [0, 1) for 10k draws", () => {
    const rng = seededRng(12345);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("enables differential testing against rollDice", () => {
    // The canonical differential pattern: two independent RNG streams
    // seeded identically produce identical dice results when passed
    // through the same primitive.
    for (let seed = 1; seed <= 50; seed++) {
      const a = rollDice("3d6", seededRng(seed));
      const b = rollDice("3d6", seededRng(seed));
      expect(a.rolls).toEqual(b.rolls);
      expect(a.total).toBe(b.total);
    }
  });
});

describe("sequenceRng", () => {
  it("returns values in order", () => {
    const rng = sequenceRng([0.1, 0.5, 0.9]);
    expect(rng()).toBe(0.1);
    expect(rng()).toBe(0.5);
    expect(rng()).toBe(0.9);
  });

  it("cycles when exhausted", () => {
    const rng = sequenceRng([0.1, 0.9]);
    expect(rng()).toBe(0.1);
    expect(rng()).toBe(0.9);
    expect(rng()).toBe(0.1);
    expect(rng()).toBe(0.9);
  });

  it("forces specific dice results", () => {
    // Formula: rng (desired - 1) / sides yields that die.
    // On d6: 0.0 → 1, 0.999 → 6.
    const rng = sequenceRng([0.0, 0.999]);
    const result = rollDice("2d6", rng);
    expect(result.rolls).toEqual([1, 6]);
  });

  it("throws on empty input", () => {
    expect(() => sequenceRng([])).toThrow(/at least one value/);
  });

  it("throws on out-of-range values", () => {
    expect(() => sequenceRng([1.0])).toThrow(/\[0, 1\)/);
    expect(() => sequenceRng([-0.1])).toThrow(/\[0, 1\)/);
  });
});
