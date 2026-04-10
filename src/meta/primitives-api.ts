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

## MCP Tool Pattern

Game tools must be defined using this exact pattern:

\`\`\`typescript
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { rollDice } from "../lib/primitives/index.js";

export function createMyTool() {
  return tool(
    "tool_name",
    "Clear description of what this tool does and when GM Claude should use it",
    {
      paramName: z.string().describe("What this parameter is"),
      optionalParam: z.number().optional().describe("Optional param"),
    },
    async (args) => {
      // Call primitives, interpret results
      const result = rollDice(args.notation);

      // Return JSON for GM Claude to interpret narratively
      return {
        content: [{ type: "text" as const, text: JSON.stringify(resultObject) }]
      };

      // For errors, return isError: true instead of throwing:
      // return { content: [{ type: "text" as const, text: "Error message" }], isError: true };
    }
  );
}
\`\`\`

## Test Pattern

Tests use vitest and inject a deterministic RNG:

\`\`\`typescript
import { describe, it, expect } from "vitest";

function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("toolName", () => {
  it("does the thing", () => {
    // Call the pure logic function with a seeded RNG
    // Assert on the result
  });
});
\`\`\`
`;
