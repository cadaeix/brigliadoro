// Fixture file — read by the auditor as text. Realistic-shape but stub
// in execution; not actually compiled or run by the test suite.
//
// THIS TOOL IS THE POSITIVE CASE in the rng-not-threaded fixture: pure
// function takes rng, factory takes rng, handler threads rng into the
// pure-function call. The auditor should report uses_rng: true,
// severity: ok, no issues.

import { rollOnTable, type Table } from "../lib/primitives/index.js";

export interface RollComplicationArgs {}

export type OutcomeTier = "generated";

export interface RollComplicationResult {
  outcome_tier: OutcomeTier;
  complication: string;
  roll: { value: number };
}

const COMPLICATIONS: Table<string> = {
  notation: "1d6",
  entries: [
    { range: [1, 1], value: "The post was searched." },
    { range: [2, 2], value: "The letter is months late." },
    { range: [3, 3], value: "The handwriting is not your correspondent's." },
    { range: [4, 4], value: "There is a second letter in the envelope." },
    { range: [5, 5], value: "The paper is from a place neither of you have been." },
    { range: [6, 6], value: "No complication." },
  ],
};

// Pure function correctly threads rng to the primitive.
export function rollComplicationPure(
  _args: RollComplicationArgs,
  rng: () => number = Math.random
): RollComplicationResult {
  const result = rollOnTable(COMPLICATIONS, rng);
  return {
    outcome_tier: "generated",
    complication: result.value,
    roll: { value: result.roll },
  };
}

// CORRECT: factory accepts rng, handler threads it into the pure-function call.
export function createRollComplication(rng: () => number = Math.random) {
  return {
    name: "roll_complication",
    description: "stub",
    handler: async (args: RollComplicationArgs) => {
      const result = rollComplicationPure(args, rng);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}
