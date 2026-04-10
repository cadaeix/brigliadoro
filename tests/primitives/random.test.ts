import { describe, it, expect } from "vitest";
import {
  drawFromPool,
  weightedPick,
  shuffle,
  coinFlip,
} from "../../src/primitives/random.js";

function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("drawFromPool", () => {
  const pool = ["A", "B", "C", "D"];

  it("draws without replacement", () => {
    // rng 0.0 → index 0 ("A"), then pool is ["B","C","D"], rng 0.5 → index 1 ("C")
    const result = drawFromPool(pool, 2, { rng: seededRng([0.0, 0.5]) });
    expect(result.drawn).toEqual(["A", "C"]);
    expect(result.remaining).toBe(2);
    expect(result.replacement).toBe(false);
  });

  it("draws with replacement", () => {
    // rng 0.0 → index 0 ("A"), rng 0.0 → index 0 ("A") again
    const result = drawFromPool(pool, 2, {
      replacement: true,
      rng: seededRng([0.0, 0.0]),
    });
    expect(result.drawn).toEqual(["A", "A"]);
    expect(result.remaining).toBe(4); // pool unchanged
  });

  it("throws on empty pool", () => {
    expect(() => drawFromPool([], 1)).toThrow("empty pool");
  });

  it("throws when drawing more than available without replacement", () => {
    expect(() => drawFromPool(["A"], 2)).toThrow("Cannot draw 2");
  });
});

describe("weightedPick", () => {
  it("picks according to weights", () => {
    const entries = [
      { item: "common", weight: 90 },
      { item: "rare", weight: 10 },
    ];
    // rng 0.5 → roll = 50, cumulative: 90 > 50, picks "common"
    const result = weightedPick(entries, seededRng([0.5]));
    expect(result.picked).toBe("common");
  });

  it("picks rare when roll is high", () => {
    const entries = [
      { item: "common", weight: 10 },
      { item: "rare", weight: 90 },
    ];
    // rng 0.95 → roll = 95, cumulative: 10 < 95, 100 > 95, picks "rare"
    const result = weightedPick(entries, seededRng([0.95]));
    expect(result.picked).toBe("rare");
  });

  it("throws on empty list", () => {
    expect(() => weightedPick([])).toThrow("empty list");
  });
});

describe("shuffle", () => {
  it("returns a new array with same elements", () => {
    const items = [1, 2, 3, 4, 5];
    const result = shuffle(items, seededRng([0.1, 0.5, 0.9, 0.3]));
    expect(result).toHaveLength(5);
    expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not mutate original", () => {
    const items = [1, 2, 3];
    shuffle(items);
    expect(items).toEqual([1, 2, 3]);
  });
});

describe("coinFlip", () => {
  it("returns heads when rng < 0.5", () => {
    expect(coinFlip(seededRng([0.3]))).toBe("heads");
  });

  it("returns tails when rng >= 0.5", () => {
    expect(coinFlip(seededRng([0.7]))).toBe("tails");
  });
});
