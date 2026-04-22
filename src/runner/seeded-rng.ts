/**
 * Seeded / scripted RNG mode for play sessions.
 *
 * When a runner is launched with `--seed=N` or `--rng-sequence=...`, we
 * monkey-patch `Math.random` at startup with a deterministic PRNG. Every
 * primitive, tool pure function, and handler threads `Math.random` as its
 * RNG default, so swapping the global makes the whole game's dice stream
 * reproducible from a seed.
 *
 * This is v0 plumbing. See `C:\Users\Cad\.claude\plans\seed-mode.md` for
 * the rationale + a proper-threading V1 path deferred until needed.
 *
 * The bookkeeper subagent + any future remote-model subagent runs on a
 * Claude model across the SDK boundary — it doesn't consume the process's
 * `Math.random`. Session-id generation is handled by the Agent SDK. So the
 * global patch only affects what we want it to affect: game-tool dice.
 *
 * Mulberry32 reused from `../test-helpers/index.js` so dev and test paths
 * share the same PRNG implementation.
 */
import { seededRng, sequenceRng } from "../test-helpers/index.js";

/** Call the returned function to restore the original `Math.random`. */
export type RestoreRng = () => void;

/**
 * Install a Mulberry32-seeded RNG as the process-wide `Math.random`.
 * Returns a restore function that puts the original back.
 */
export function installSeededRng(seed: number): RestoreRng {
  const rng = seededRng(seed);
  return installRng(rng);
}

/**
 * Install a cycling sequence as the process-wide `Math.random`. Values must
 * be in [0, 1). Useful when you need to force specific dice outcomes.
 * Returns a restore function.
 */
export function installSequenceRng(values: number[]): RestoreRng {
  const rng = sequenceRng(values);
  return installRng(rng);
}

function installRng(rng: () => number): RestoreRng {
  const original = Math.random;
  Math.random = rng;
  return () => {
    Math.random = original;
  };
}

/**
 * Parse a `--rng-sequence=0.1,0.5,0.9` value into a number array. Throws
 * with a clear message if any entry isn't a finite number in [0, 1).
 */
export function parseSequenceArg(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error("--rng-sequence requires at least one value");
  }
  const values: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) {
      throw new Error(`--rng-sequence entry is not a finite number: ${part}`);
    }
    if (n < 0 || n >= 1) {
      throw new Error(`--rng-sequence entry must be in [0, 1): ${part}`);
    }
    values.push(n);
  }
  return values;
}
