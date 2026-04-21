/**
 * Shared hint-vocabulary types used by every generated game tool.
 *
 * Tools emit structured hints (not prose) for the facilitator agent to
 * turn into fiction. These are the cross-game shared enums; `outcome_tier`
 * stays local to each tool because the tier vocabulary is game-specific
 * (e.g. PbtA `critical | success | partial | failure`, a d20 hit/miss,
 * a pure-generator `generated` tag, etc.).
 *
 * Generated tool files import these types instead of redeclaring them per
 * file. The file compiles to dist/hints/index.js and is copied into each
 * runner's lib/hints/ at generation time.
 *
 * See `src/meta/primitives-api.ts` "Hint vocabulary" section for the full
 * contract + usage rules.
 */

/** How this outcome moves narrative tension. */
export type Pressure = "falling" | "held" | "rising" | "spiking";

/** Closed catalog of narrative-beat nudges for the facilitator. */
export type SuggestedBeat =
  | "complication"
  | "cost"
  | "escalation"
  | "revelation"
  | "opening"
  | "setback"
  | "advantage"
  | "reprieve";

/**
 * Runtime-readable arrays for the enums above — useful for Zod schemas,
 * validation, or iterating all possible values.
 */
export const PRESSURE_VALUES = [
  "falling",
  "held",
  "rising",
  "spiking",
] as const satisfies readonly Pressure[];

export const SUGGESTED_BEAT_VALUES = [
  "complication",
  "cost",
  "escalation",
  "revelation",
  "opening",
  "setback",
  "advantage",
  "reprieve",
] as const satisfies readonly SuggestedBeat[];
