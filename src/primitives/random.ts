import type { DrawResult, WeightedPickResult } from "../types/index.js";

/**
 * Draw items from a pool, with or without replacement.
 *
 * @param pool - Items to draw from
 * @param count - Number of items to draw
 * @param options.replacement - If true, items can be drawn more than once
 * @param options.rng - Random number generator returning [0, 1)
 */
export function drawFromPool(
  pool: string[],
  count: number,
  options: { replacement?: boolean; rng?: () => number } = {}
): DrawResult {
  const { replacement = false, rng = Math.random } = options;

  if (pool.length === 0) {
    throw new Error("Cannot draw from an empty pool");
  }
  if (!replacement && count > pool.length) {
    throw new Error(
      `Cannot draw ${count} items without replacement from a pool of ${pool.length}`
    );
  }
  if (count < 1) {
    throw new Error("Must draw at least 1 item");
  }

  const drawn: string[] = [];

  if (replacement) {
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(rng() * pool.length);
      drawn.push(pool[idx]!);
    }
    return { drawn, remaining: pool.length, replacement: true };
  }

  // Without replacement: work on a copy
  const available = [...pool];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * available.length);
    drawn.push(available[idx]!);
    available.splice(idx, 1);
  }

  return { drawn, remaining: available.length, replacement: false };
}

/**
 * Pick one item from a weighted list.
 *
 * @param entries - Items with associated weights (must be positive)
 * @param rng - Random number generator returning [0, 1)
 */
export function weightedPick(
  entries: Array<{ item: string; weight: number }>,
  rng: () => number = Math.random
): WeightedPickResult {
  if (entries.length === 0) {
    throw new Error("Cannot pick from an empty list");
  }

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("Total weight must be positive");
  }

  const roll = rng() * totalWeight;
  let cumulative = 0;

  for (const entry of entries) {
    cumulative += entry.weight;
    if (roll < cumulative) {
      return { picked: entry.item, weight: entry.weight, roll };
    }
  }

  // Floating-point edge case: return last entry
  const last = entries[entries.length - 1]!;
  return { picked: last.item, weight: last.weight, roll };
}

/**
 * Shuffle an array using Fisher-Yates algorithm.
 * Returns a new array; does not mutate the input.
 */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Flip a coin.
 */
export function coinFlip(rng: () => number = Math.random): "heads" | "tails" {
  return rng() < 0.5 ? "heads" : "tails";
}
