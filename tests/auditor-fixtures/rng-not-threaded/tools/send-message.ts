// Fixture file — read by the auditor as text. Realistic-shape but stub
// in execution; not actually compiled or run by the test suite.
//
// THIS FIXTURE INTENTIONALLY VIOLATES THE RNG-THREADING CONTRACT:
// the pure function takes rng (correctly), but `createSendMessage`
// doesn't accept an rng parameter and the handler calls
// `sendMessagePure(args)` without threading rng. The auditor should
// flag this with `kind: "factory_no_rng_param"` and severity blocker.

import { rollDice } from "../lib/primitives/index.js";
import type { Pressure, SuggestedBeat } from "../lib/hints/index.js";

export interface SendMessageArgs {
  sender_name: string;
}

export type OutcomeTier = "clear" | "garbled" | "lost";

export interface SendMessageResult {
  outcome_tier: OutcomeTier;
  pressure?: Pressure;
  suggested_beats?: SuggestedBeat[];
  cipher_broken: boolean;
  roll: { rolls: number[]; total: number; notation: string };
}

// Pure function correctly accepts rng (Gate-1 differential testable).
export function sendMessagePure(
  args: SendMessageArgs,
  rng: () => number = Math.random
): SendMessageResult {
  const r = rollDice("2d6", rng);
  const high = Math.max(...r.rolls);
  const cipher_broken = r.rolls[0] === r.rolls[1];
  const outcome_tier: OutcomeTier =
    high === 6 ? "clear" : high >= 4 ? "garbled" : "lost";
  return {
    outcome_tier,
    cipher_broken,
    roll: { rolls: r.rolls, total: r.total, notation: r.notation },
  };
}

// BUG: factory doesn't accept rng. Handler calls sendMessagePure without
// threading rng. The pure function defaults to Math.random and
// handler-integration tests can't seed deterministically.
export function createSendMessage() {
  return {
    name: "send_message",
    description: "stub",
    handler: async (args: SendMessageArgs) => {
      const result = sendMessagePure(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}
