import { describe, it, expect } from "vitest";
import { parseDiceNotation, rollDice } from "../../src/primitives/dice.js";

// Returns values 0..n-1 in sequence, scaled to [0, 1)
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("parseDiceNotation", () => {
  it("parses basic NdS", () => {
    const p = parseDiceNotation("2d6");
    expect(p).toEqual({ count: 2, sides: 6, modifier: 0, exploding: false });
  });

  it("parses implicit 1dS", () => {
    const p = parseDiceNotation("d20");
    expect(p.count).toBe(1);
    expect(p.sides).toBe(20);
  });

  it("parses modifiers", () => {
    expect(parseDiceNotation("1d20+5").modifier).toBe(5);
    expect(parseDiceNotation("2d6-2").modifier).toBe(-2);
  });

  it("parses keep highest", () => {
    const p = parseDiceNotation("4d6kh3");
    expect(p.keep).toEqual({ type: "highest", count: 3 });
  });

  it("parses keep lowest", () => {
    const p = parseDiceNotation("2d20kl1");
    expect(p.keep).toEqual({ type: "lowest", count: 1 });
  });

  it("parses exploding", () => {
    expect(parseDiceNotation("1d6!").exploding).toBe(true);
  });

  it("parses d%", () => {
    const p = parseDiceNotation("d%");
    expect(p).toEqual({ count: 1, sides: 100, modifier: 0, exploding: false });
  });

  it("parses Fate dice", () => {
    const p = parseDiceNotation("4dF");
    expect(p.count).toBe(4);
    expect(p.sides).toBe("F");
  });

  it("rejects invalid notation", () => {
    expect(() => parseDiceNotation("abc")).toThrow("Invalid dice notation");
  });

  it("rejects keep > count", () => {
    expect(() => parseDiceNotation("2d6kh5")).toThrow("Cannot keep 5");
  });

  it("rejects exploding Fate dice", () => {
    expect(() => parseDiceNotation("2dF!")).toThrow("Exploding Fate");
  });
});

describe("rollDice", () => {
  it("rolls 2d6 with deterministic rng", () => {
    // rng values: 0.5 → floor(0.5*6)+1 = 4, 0.999 → floor(0.999*6)+1 = 6
    const result = rollDice("2d6", seededRng([0.5, 0.999]));
    expect(result.rolls).toEqual([4, 6]);
    expect(result.kept).toEqual([4, 6]);
    expect(result.modifier).toBe(0);
    expect(result.total).toBe(10);
  });

  it("applies modifier", () => {
    const result = rollDice("1d20+5", seededRng([0.5]));
    // floor(0.5*20)+1 = 11, +5 = 16
    expect(result.total).toBe(16);
    expect(result.modifier).toBe(5);
  });

  it("keeps highest", () => {
    // 4d6: rng 0.0→1, 0.5→4, 0.999→6, 0.166→1  (floor(r*6)+1)
    const result = rollDice("4d6kh3", seededRng([0.0, 0.5, 0.999, 0.166]));
    expect(result.rolls).toEqual([1, 4, 6, 1]);
    // keep highest 3: [6, 4, 1]
    expect(result.kept).toEqual([6, 4, 1]);
    expect(result.total).toBe(11);
  });

  it("keeps lowest", () => {
    // 2d20: rng 0.95→20, 0.1→3
    const result = rollDice("2d20kl1", seededRng([0.95, 0.1]));
    expect(result.rolls).toEqual([20, 3]);
    expect(result.kept).toEqual([3]);
    expect(result.total).toBe(3);
  });

  it("handles exploding dice", () => {
    // 1d6!: first roll 0.999→6 (max, explodes), second roll 0.5→4 (not max, stops)
    // total = 6 + 4 = 10
    const result = rollDice("1d6!", seededRng([0.999, 0.5]));
    expect(result.rolls).toEqual([10]);
    expect(result.total).toBe(10);
  });

  it("rolls Fate dice", () => {
    // 4dF: rng values → floor(r*3)-1: 0.0→-1, 0.4→0, 0.7→+1, 0.35→0
    const result = rollDice("4dF", seededRng([0.0, 0.4, 0.7, 0.35]));
    expect(result.rolls).toEqual([-1, 0, 1, 0]);
    expect(result.total).toBe(0);
  });

  it("rolls d%", () => {
    const result = rollDice("d%", seededRng([0.41]));
    // floor(0.41*100)+1 = 42
    expect(result.total).toBe(42);
  });

  it("includes human-readable details", () => {
    const result = rollDice("2d6+3", seededRng([0.0, 0.833]));
    expect(result.details).toContain("=");
    expect(result.details).toContain("+3");
  });
});
