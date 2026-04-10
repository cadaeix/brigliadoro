import type { ParsedDice, DiceRollResult } from "../types/index.js";

/**
 * Parse standard dice notation into a structured object.
 *
 * Supported formats:
 *   NdS        — roll N dice with S sides (2d6)
 *   dS         — shorthand for 1dS (d20)
 *   NdS+M      — with positive modifier (1d20+5)
 *   NdS-M      — with negative modifier (2d6-1)
 *   NdSkhK     — keep highest K (4d6kh3)
 *   NdSklK     — keep lowest K (2d20kl1)
 *   NdS!       — exploding dice (reroll on max, add result)
 *   d%         — percentile, alias for 1d100
 *   NdF        — Fate/Fudge dice (-1, 0, +1)
 */
export function parseDiceNotation(notation: string): ParsedDice {
  const trimmed = notation.trim().toLowerCase();

  // d% → 1d100
  if (trimmed === "d%") {
    return { count: 1, sides: 100, modifier: 0, exploding: false };
  }

  const pattern =
    /^(\d*)d(f|\d+)(!)?(kh(\d+)|kl(\d+))?([+-]\d+)?$/;
  const match = trimmed.match(pattern);
  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}"`);
  }

  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides: number | "F" = match[2] === "f" ? "F" : parseInt(match[2]!, 10);
  const exploding = match[3] === "!";
  const keepHighest = match[5] ? parseInt(match[5], 10) : undefined;
  const keepLowest = match[6] ? parseInt(match[6], 10) : undefined;
  const modifier = match[7] ? parseInt(match[7], 10) : 0;

  if (typeof sides === "number" && sides < 1) {
    throw new Error(`Dice must have at least 1 side: "${notation}"`);
  }
  if (count < 1) {
    throw new Error(`Must roll at least 1 die: "${notation}"`);
  }

  const keep = keepHighest !== undefined
    ? { type: "highest" as const, count: keepHighest }
    : keepLowest !== undefined
      ? { type: "lowest" as const, count: keepLowest }
      : undefined;

  if (keep && keep.count > count) {
    throw new Error(
      `Cannot keep ${keep.count} dice when only rolling ${count}: "${notation}"`
    );
  }

  if (exploding && sides === "F") {
    throw new Error(`Exploding Fate dice are not supported: "${notation}"`);
  }

  return { count, sides, modifier, keep, exploding };
}

const MAX_EXPLODE = 100;

function rollSingleDie(
  sides: number | "F",
  rng: () => number
): number {
  if (sides === "F") {
    // Fate die: -1, 0, or +1 with equal probability
    const r = Math.floor(rng() * 3);
    return r - 1;
  }
  return Math.floor(rng() * sides) + 1;
}

/**
 * Roll dice using standard notation.
 *
 * @param notation - Dice notation string (e.g. "2d6+1", "4d6kh3", "1d20!")
 * @param rng - Random number generator returning [0, 1). Defaults to Math.random.
 *              Inject a deterministic function for testing.
 */
export function rollDice(
  notation: string,
  rng: () => number = Math.random
): DiceRollResult {
  const parsed = parseDiceNotation(notation);
  const { count, sides, modifier, keep, exploding } = parsed;

  // Roll all dice
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    let value = rollSingleDie(sides, rng);

    if (exploding && typeof sides === "number") {
      let explodeCount = 0;
      let current = value;
      while (current === sides && explodeCount < MAX_EXPLODE) {
        const extra = rollSingleDie(sides, rng);
        value += extra;
        current = extra;
        explodeCount++;
      }
    }

    rolls.push(value);
  }

  // Apply keep logic
  let kept: number[];
  if (keep) {
    const sorted = [...rolls].sort((a, b) => b - a); // descending
    if (keep.type === "highest") {
      kept = sorted.slice(0, keep.count);
    } else {
      kept = sorted.slice(-keep.count);
    }
  } else {
    kept = [...rolls];
  }

  const sum = kept.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  // Build human-readable details
  let details = `[${rolls.join(", ")}]`;
  if (keep) {
    details += ` k${keep.type === "highest" ? "h" : "l"}${keep.count} → [${kept.join(", ")}]`;
  }
  if (modifier !== 0) {
    details += ` ${modifier > 0 ? "+" : ""}${modifier}`;
  }
  details += ` = ${total}`;

  return {
    notation: notation.trim(),
    rolls,
    kept,
    modifier,
    total,
    details,
  };
}
