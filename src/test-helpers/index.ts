/**
 * Deterministic RNG utilities for differential testing.
 *
 * Two flavors:
 * - `seededRng(seed)` — Mulberry32 PRNG. Use for bulk property-style tests
 *   where you want many distinct deterministic streams.
 * - `sequenceRng(values)` — returns values in order, cycling. Use for hand-crafted
 *   scenarios where you want to force specific dice results.
 *
 * Both return a `() => number` in [0, 1) matching `Math.random`'s contract,
 * so they can be passed anywhere a primitive accepts an optional RNG.
 *
 * The differential testing pattern for generated tools:
 *   const toolRng = seededRng(42);
 *   const primRng = seededRng(42);
 *   const viaTool = somePureToolFn(args, toolRng);
 *   const viaPrim = rollDice("2d6", primRng);
 *   expect(viaTool.roll.rolls).toEqual(viaPrim.rolls);
 *
 * Because both RNGs start from the same seed, the sequences are identical —
 * any divergence between the tool's mechanical output and the primitive's
 * output is a bug in the generated wrapper.
 */

/**
 * Mulberry32 — fast, small-state seedable PRNG.
 * Returns values in [0, 1) suitable as a drop-in for Math.random.
 *
 * Same seed → same sequence forever. Different seeds → statistically
 * independent streams.
 */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sequence-based RNG — returns the given values in order, cycling back to
 * the start when exhausted. Use for hand-crafted test scenarios where you
 * want to force specific dice outcomes.
 *
 * Example: `sequenceRng([0.0, 0.999])` on two d6 rolls yields [1, 6].
 * Formula: rng value `(desired - 1) / sides` gives the desired die result.
 */
export function sequenceRng(values: number[]): () => number {
  if (values.length === 0) {
    throw new Error("sequenceRng requires at least one value");
  }
  for (const v of values) {
    if (!(v >= 0 && v < 1)) {
      throw new Error(`sequenceRng values must be in [0, 1), got ${v}`);
    }
  }
  let i = 0;
  return () => values[i++ % values.length]!;
}
