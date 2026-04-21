/**
 * API reference for the foundation primitives.
 * This string is injected into Brigliadoro's system prompt
 * so it knows how to generate game tools that call our primitives.
 */
export const PRIMITIVES_API_REFERENCE = `
## Foundation Primitives API

These are the available primitives you MUST use when generating game tools.
Import them from the runner's lib folder: \`import { rollDice, drawFromPool, ... } from "../lib/primitives/index.js";\`

### rollDice(notation: string, rng?: () => number): DiceRollResult

Roll dice using standard notation.

Parameters:
- notation: Dice notation string
  - "NdS" — roll N dice with S sides (e.g., "2d6", "3d8")
  - "NdS+M" / "NdS-M" — with modifier (e.g., "1d20+5")
  - "NdSkhK" — keep highest K dice (e.g., "4d6kh3")
  - "NdSklK" — keep lowest K dice (e.g., "2d20kl1")
  - "NdS!" — exploding dice (e.g., "1d6!")
  - "d%" — percentile (1d100)
  - "NdF" — Fate/Fudge dice (-1, 0, +1)
- rng: Optional RNG function returning [0, 1). Default: Math.random. Inject for testing.

Returns DiceRollResult:
  {
    notation: string,     // original notation
    rolls: number[],      // all individual die results
    kept: number[],       // dice kept after kh/kl filtering
    modifier: number,     // numeric modifier
    total: number,        // sum of kept dice + modifier
    details: string       // human-readable breakdown
  }

### drawFromPool(pool: string[], count: number, options?): DrawResult

Draw items from a pool/list.

Parameters:
- pool: Array of items to draw from
- count: Number of items to draw
- options.replacement: boolean (default false) — if true, items can repeat
- options.rng: Optional RNG function

Returns DrawResult:
  { drawn: string[], remaining: number, replacement: boolean }

### weightedPick(entries: {item: string, weight: number}[], rng?): WeightedPickResult

Pick one item from a weighted list.

Returns: { picked: string, weight: number, roll: number }

### shuffle<T>(items: T[], rng?): T[]

Fisher-Yates shuffle. Returns new array, does not mutate input.

### coinFlip(rng?): "heads" | "tails"

### setResource(entity: string, resource: string, value: number, current?: ResourceState, bounds?: {min?, max?}): ResourceOpResult

Create or overwrite a resource.

ResourceState: { value: number, min?: number, max?: number }
ResourceOpResult: { entity, resource, previousValue, newValue, clampedAtMin, clampedAtMax }

### modifyResource(entity: string, resource: string, delta: number, current: ResourceState): ResourceOpResult

Add (positive delta) or subtract (negative delta) from a resource. Clamps to min/max.

### createClock(name: string, segments: number): ClockState

ClockState: { name, segments, filled, complete }

### advanceClock(clock: ClockState, segments?: number): ClockOpResult

Fill segments (default 1). Caps at max.
ClockOpResult: { clock: ClockState, previousFilled, justCompleted }

### reduceClock(clock: ClockState, segments?: number): ClockOpResult

Unfill segments (default 1). Floors at 0.

## Types for import

import type {
  DiceRollResult, ParsedDice,
  DrawResult, WeightedPickResult,
  ResourceState, ResourceOpResult,
  ClockState, ClockOpResult, DeckState
} from "../lib/types/index.js";

## MCP Tool Pattern — pure function + thin handler (MANDATORY)

Every generated tool file MUST export two things:

1. A **pure function** \`<toolName>Pure(args, rng?)\` that does all mechanical work
   and accepts an optional RNG. This is the differential-testing target.
2. A **\`createX()\` factory** that wraps the pure function in an MCP \`tool()\`
   handler. The handler is a thin wrapper — NO mechanical logic lives in it.

Why: the pure function is trivially testable with a seeded RNG and can be
differentially compared against the primitive oracle. The handler is the MCP
shape Claude sees. Keeping them separate means a Gate 1 differential test
("tool dice match direct primitive call for same seed") is always possible.

\`\`\`typescript
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { rollDice } from "../lib/primitives/index.js";

// (1) Pure function — all mechanical logic lives here.
// Accepts an optional rng (defaults to Math.random) for seeded testing.
export interface MyToolArgs {
  notation: string;
  optionalParam?: number;
}

export interface MyToolResult {
  roll: { rolls: number[]; total: number; notation: string };
  outcome: "success" | "partial" | "failure";
  // ... any other structured mechanical facts
}

export function myToolPure(
  args: MyToolArgs,
  rng: () => number = Math.random
): MyToolResult {
  const roll = rollDice(args.notation, rng);
  const outcome = roll.total >= 10 ? "success" : roll.total >= 7 ? "partial" : "failure";
  return { roll: { rolls: roll.rolls, total: roll.total, notation: roll.notation }, outcome };
}

// (2) Thin MCP handler — no mechanical work; returns structured hints only.
export function createMyTool() {
  return tool(
    "tool_name",
    "Clear description of WHEN the facilitator should use this tool (narrative trigger).",
    {
      notation: z.string().describe("Dice notation like '2d6'"),
      optionalParam: z.number().optional().describe("Optional param"),
    },
    async (args) => {
      const result = myToolPure(args);
      // Dual-channel output: hints in content, full mechanical record in
      // structuredContent. NO prose sentences — the facilitator owns voice.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
        structuredContent: result,
      };

      // For recoverable errors return isError: true instead of throwing:
      // return { content: [{ type: "text" as const, text: "Error message" }], isError: true };
    }
  );
}
\`\`\`

**Note**: the pure function's \`outcome\` field above becomes the \`outcome_tier\`
hint. In a real tool, also emit \`pressure\`, \`salient_facts\`, and
\`suggested_beats\` where meaningful (see "Hint vocabulary" below).

## Test Pattern — differential gate against primitive oracle

Tests use vitest and deterministic RNGs from the runner's lib:

\`\`\`typescript
import { describe, it, expect } from "vitest";
import { seededRng, sequenceRng } from "../lib/test-helpers/index.js";
import { rollDice } from "../lib/primitives/index.js";
import { myToolPure } from "../tools/my-tool.js";

describe("my_tool", () => {
  // Gate 1: DIFFERENTIAL TEST — mandatory for any tool touching an RNG primitive.
  // Seed the tool's RNG and the primitive's RNG identically. The raw dice
  // values the tool consumed MUST match what the primitive produces directly.
  // This catches any wrapper bug that lost, reordered, or double-consumed rolls.
  it("rolls match direct primitive call for 100 seeds", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const viaTool = myToolPure({ notation: "2d6" }, seededRng(seed));
      const viaPrim = rollDice("2d6", seededRng(seed));
      expect(viaTool.roll.rolls).toEqual(viaPrim.rolls);
      expect(viaTool.roll.total).toEqual(viaPrim.total);
    }
  });

  // Scenario tests: use sequenceRng for hand-crafted dice outcomes.
  // Formula: rng value (desired - 1) / sides → that die result.
  // e.g. [0.0, 0.999] on 2d6 yields [1, 6].
  it("yields failure outcome when dice total is low", () => {
    const result = myToolPure({ notation: "2d6" }, sequenceRng([0.0, 0.0]));
    expect(result.outcome).toBe("failure");
  });
});
\`\`\`

## Pausable tools (multi-phase resolution)

Some mechanics need player input DURING resolution, not just before it.
Examples: blackjack (hit/stand between card draws), push-your-luck rolls,
any system where a mid-resolution choice changes the outcome.

These tools follow the **re-entrant state-machine pattern**. The tool is
called multiple times with a \`phase\` parameter; state persists between
calls via a \`StepStore\`; the facilitator alternates with the player between calls.

### The flow

\`\`\`
  1. Facilitator calls tool:  { phase: "start", stepId }
     Tool deals initial state, stores it keyed by stepId, returns
     { status: "awaiting_input", stepId, prompt: "Hit or stand?" }

  2. Facilitator sees awaiting_input → narrates situation, presents the choice
     conversationally to the player. DOES NOT call anything else yet.

  3. Player responds: "I'll hit."

  4. Facilitator calls tool:  { phase: "continue", stepId, action: "hit" }
     Tool reloads state, advances, either:
       - returns { status: "awaiting_input", ... } (loop to step 2), or
       - returns { status: "done", output: finalResult } (tool deletes stepId)
\`\`\`

\`AskUserQuestion\` does NOT work here — the SDK's Claude subprocess has no
TTY and the tool silently fails. The turn-taking above is what replaces it:
the facilitator's conversational response IS the ask; player's next message IS
the answer. No special SDK features needed.

### Pure step function shape

A pausable tool's pure function is a **step function** — it takes the
current state and an input, returns the next state and a step outcome:

\`\`\`typescript
import { InMemoryStepStore, type StepStore } from "../lib/state/step-store.js";

// State the mechanic needs to remember across turns.
export interface BlackjackState {
  deck: string[];
  player: string[];
  dealer: string[];
}

// Inputs the step fn accepts. "start" creates initial state; others advance it.
export type BlackjackInput =
  | { kind: "start" }
  | { kind: "hit" }
  | { kind: "stand" };

// Step outcomes. awaiting → store and loop; done → delete and return.
export type BlackjackStep =
  | { kind: "awaiting"; state: BlackjackState; prompt: string }
  | { kind: "done"; state: BlackjackState; result: "win" | "lose" | "push" };

export function blackjackStep(
  prev: BlackjackState | null,
  input: BlackjackInput,
  rng: () => number = Math.random
): BlackjackStep {
  // ... state machine logic, using primitives for all randomness ...
  throw new Error("example only");
}
\`\`\`

### Handler shape

The MCP handler is still a thin wrapper. It loads state, calls the step
function, stores or deletes depending on the step kind, and shapes the
return payload. It never does mechanical work itself.

\`\`\`typescript
export function createBlackjack(store: StepStore) {
  return tool(
    "resolve_blackjack",
    // Description must tell the facilitator about the re-entry protocol.
    "Drive one blackjack round. Call with phase='start' to deal. " +
    "If the result has status='awaiting_input', present the prompt to " +
    "the player conversationally and wait for their reply, then call " +
    "this tool again with phase='continue', the same stepId, and the " +
    "player's action. Repeat until status='done'.",
    {
      phase: z.enum(["start", "continue"]),
      stepId: z.string().describe("Stable ID for this round. Reuse across start/continue calls."),
      action: z.enum(["hit", "stand"]).optional().describe("Required when phase is 'continue'."),
    },
    async (args) => {
      const prev = args.phase === "start"
        ? null
        : (await store.get<BlackjackState>(args.stepId)) ?? null;

      const input: BlackjackInput = args.phase === "start"
        ? { kind: "start" }
        : { kind: args.action! };

      const step = blackjackStep(prev, input);

      if (step.kind === "awaiting") {
        await store.put(args.stepId, step.state);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "awaiting_input",
            stepId: args.stepId,
            prompt: step.prompt,
          })}],
          structuredContent: { status: "awaiting_input", stepId: args.stepId, state: step.state, prompt: step.prompt },
        };
      }

      // done
      await store.del(args.stepId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "done",
          result: step.result,
        })}],
        structuredContent: { status: "done", state: step.state, result: step.result },
      };
    }
  );
}
\`\`\`

### Differential testing a step function

Step functions are still differentially testable — seed an RNG, drive a
canonical input sequence, assert state transitions match primitive-direct
equivalents. The test just iterates over more steps:

\`\`\`typescript
it("dealt cards match direct primitive draws for seeded sequences", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const step = blackjackStep(null, { kind: "start" }, seededRng(seed));
    // Drive a direct drawFromPool with the same seed, assert the cards match.
  }
});
\`\`\`

### When to use this pattern

Use the pausable pattern when a mechanic needs mid-resolution player input.
Do NOT use it for one-shot mechanics (roll 2d6, interpret outcome, done) —
that's overkill. One-shot tools use the simple pattern from the MCP Tool
Pattern section above.

Rule of thumb: if the mechanic has a "between" — between the first draw
and the second, between the attack roll and the defence roll — it's
probably pausable. If it resolves in one \`rollDice\` call, it's one-shot.

## Hint vocabulary (tool outputs)

**Tools emit structured hints, never prose sentences.** The facilitator agent owns
narrative voice — any prose the tool writes competes with or contradicts the
facilitatorPrompt's tone guidance. Tool returns are signals; the facilitator turns them into
fiction.

### Required fields

- \`outcome_tier: string\` — game-defined enum (e.g. \`critical | success | partial | failure\` for a PbtA move, \`hit | miss\` for a d20 attack). Pick 2–5 tiers that match the mechanic. The facilitatorPrompt MUST cover how to narrate each tier.

### Recommended fields (use when meaningful)

- \`pressure: Pressure\` — how this outcome moves narrative tension. \`spiking\` = sudden jump (crisis triggered, clock filled); \`rising\` = things tightened; \`held\` = situation unchanged; \`falling\` = release or relief.
- \`salient_facts: string[]\` — short tokens naming concrete state changes the facilitator must reflect. Use a \`kind:entity:delta\` style where possible: \`"hp:pc:-3"\`, \`"clock:nightfall:+1"\`, \`"resource:torchlight:1"\`, \`"npc:captain_darcy:revealed"\`. 0–5 tokens is plenty; don't dump state snapshots.
- \`suggested_beats: SuggestedBeat[]\` — nudges from a small closed catalog: \`complication\`, \`cost\`, \`escalation\`, \`revelation\`, \`opening\`, \`setback\`, \`advantage\`, \`reprieve\`. 0–3 beats per return. These are suggestions, not mandates; the facilitator picks what fits the fiction.

### Shared hint types — import, don't redeclare

The \`Pressure\` and \`SuggestedBeat\` types are **cross-game shared enums**, defined once in \`src/hints/index.ts\` (copied into each runner as \`lib/hints/index.js\`). Generated tool files MUST import them:

\`\`\`typescript
import type { Pressure, SuggestedBeat } from "../lib/hints/index.js";
\`\`\`

Don't redeclare them in each tool file — they're identical across all games, and a drift in one file's redeclaration would break the shared vocabulary silently.

\`OutcomeTier\` stays **local** to each tool because its values are game-specific (e.g. PbtA uses \`critical | success | partial | failure\`; a d20 attack uses \`hit | miss\`; a pure random-table generator uses \`generated\`).

### Game-specific flags

Typed booleans or short strings for mechanic-specific triggers:
\`laser_feelings_triggered: true\`, \`critical_dice: 2\`, \`trigger: "counter-attack"\`. Keep names snake_case and terse.

### What tools MUST NOT emit

- **Full sentences describing how to narrate.** "Describe how the action backfires" — no. The facilitatorPrompt says that.
- **Quoted sourcebook text.** The knowledge base handles lookup.
- **Voice-carrying adjectives.** "Spectacular success!" injects a tone that may not match the game's voice — emit \`outcome_tier: "critical"\`, \`pressure: "falling"\`, \`suggested_beats: ["advantage"]\` instead.
- **A \`guidance\` or \`narration\` prose field.** Legacy shape; drop it.

### Example

\`\`\`json
{
  "outcome_tier": "partial",
  "pressure": "rising",
  "salient_facts": ["goal_achieved", "cost_incurred"],
  "suggested_beats": ["complication", "cost"],
  "roll": { "rolls": [3, 5], "total": 8 }
}
\`\`\`

The facilitator reads this and writes prose in the game's voice. A campy game gets a pulpy complication; a grim game gets a terse cost. Same hints, different narration.

## RNG injection rules

- Every pure function that transitively calls an RNG primitive
  (\`rollDice\`, \`drawFromPool\`, \`weightedPick\`, \`shuffle\`, \`coinFlip\`)
  MUST accept an optional \`rng: () => number = Math.random\` parameter and
  thread it into every primitive call.
- NEVER use \`Math.random\` directly inside a pure function — always go
  through a primitive, and always thread the rng.
- Pure functions that touch no RNG (resource/clock ops only) don't need
  an \`rng\` param; they're already deterministic.
`;
