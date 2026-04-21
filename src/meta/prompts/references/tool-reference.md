# Tool Reference

Deep reference for building game tools. The tool-builder prompt points here when it needs exact signatures, templates, or edge-case detail. Read the section you need; don't read the whole thing unless you're orienting.

## Contents

1. [Primitives API](#primitives-api) — signatures for dice, draws, resources, clocks, tables
2. [Tool file pattern](#tool-file-pattern) — pure function + thin handler, dual-channel output
3. [Server assembly](#server-assembly) — `server.ts` shape, store injection
4. [Pausable tools](#pausable-tools) — for mechanics that need player input mid-resolution
5. [Hint vocabulary](#hint-vocabulary) — what tool returns carry
6. [Trigger eval corpus](#trigger-eval-corpus) — the `.triggers.json` format
7. [Common anti-patterns](#common-anti-patterns) — things that look right and aren't

---

## Primitives API

Import from the runner's local lib: `import { rollDice, drawFromPool, ... } from "../lib/primitives/index.js";`

Types live at `../lib/types/index.js`.

Every RNG-touching primitive accepts an optional `rng: () => number = Math.random` as its last parameter. Pure functions that transitively call these MUST accept their own `rng` and thread it through — this is how differential testing works. Never call `Math.random` directly in a pure function.

### `rollDice(notation: string, rng?): DiceRollResult`

Parses standard dice notation and rolls.

Supported notation:
- `"NdS"` — N dice of S sides (e.g. `"2d6"`, `"3d8"`)
- `"NdS+M"` / `"NdS-M"` — with modifier
- `"NdSkhK"` — keep highest K (e.g. `"4d6kh3"`)
- `"NdSklK"` — keep lowest K (e.g. `"2d20kl1"`)
- `"NdS!"` — exploding dice
- `"d%"` — percentile
- `"NdF"` — Fate / Fudge dice

Returns `{ notation, rolls, kept, modifier, total, details }`.

### `drawFromPool(pool: string[], count: number, options?): DrawResult`

Pick `count` items from a pool. `options.replacement: true` allows repeats (default false). Returns `{ drawn, remaining, replacement }`.

Use for "pick one from a shuffled set of equivalent options". Don't use for ranged-entry random tables — that's `rollOnTable`.

### `weightedPick(entries: {item: string, weight: number}[], rng?): WeightedPickResult`

Pick one item from a weighted list. Returns `{ picked, weight, roll }`.

### `shuffle<T>(items: T[], rng?): T[]`

Fisher-Yates, non-mutating. Returns a new array.

### `coinFlip(rng?): "heads" | "tails"`

### `rollOnTable<T>(table: Table<T>, rng?): TableRollResult<T>`

For TTRPG-style random tables — "roll 1d20 on Wilderness Encounter, 1-10 nothing, 11-15 lost traveller…". This is conceptually distinct from `drawFromPool`: tables have explicit ranges mapped to entries.

Table shape:

```ts
const table: Table<string> = {
  name: "Wilderness Encounter",
  notation: "1d20",
  entries: [
    { range: [1, 10], item: "nothing" },
    { range: [11, 15], item: "lost traveller" },
    { range: [16, 19], item: "brigands" },
    { range: [20, 20], item: "dragon" },
  ],
};
```

Nested tables via `rerollOnto`:

```ts
{ range: [16, 19], item: "monster", rerollOnto: monsterSubtable }
```

The return's `chain` records every reroll step. Throws on range gaps or reroll chains deeper than 10.

Returns `{ table, notation, roll, item, chain }` where `item` is the leaf after all rerolls.

**Decision rule:** if the sourcebook says "roll Xd Y on the Z table" with explicit ranges, use `rollOnTable`. If it says "pick one of these", use `drawFromPool`.

### Resource primitives

```ts
setResource(entity, resource, value, current?, bounds?): ResourceOpResult
modifyResource(entity, resource, delta, current): ResourceOpResult
```

`ResourceState = { value, min?, max? }`. `ResourceOpResult = { entity, resource, previousValue, newValue, clampedAtMin, clampedAtMax }`.

### Clock primitives

```ts
createClock(name, segments): ClockState
advanceClock(clock, segments = 1): ClockOpResult
reduceClock(clock, segments = 1): ClockOpResult
```

`ClockState = { name, segments, filled, complete }`. `ClockOpResult = { clock, previousFilled, justCompleted }`.

### Types to import

```ts
import type {
  DiceRollResult, ParsedDice,
  DrawResult, WeightedPickResult,
  ResourceState, ResourceOpResult,
  ClockState, ClockOpResult, DeckState,
  Table, TableEntry, TableRollResult, TableRollChainStep
} from "../lib/types/index.js";
```

---

## Tool file pattern

Every tool file exports two things: a **pure function** doing all mechanical work, and a **factory** wrapping that function in an MCP `tool()` handler. The handler is thin — it calls the pure function, shapes the return, and that's it. No math in handlers.

The reason is testability: the validator seeds the pure function's RNG and compares against a direct primitive call with the same seed. That's only possible when the pure function is importable and accepts an RNG.

```ts
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { rollDice } from "../lib/primitives/index.js";
import type { Pressure, SuggestedBeat } from "../lib/hints/index.js";

// Typed args for the pure function.
export interface MyToolArgs {
  paramName: string;
  optionalParam?: number;
}

// Outcome tier stays LOCAL to each tool — values are game-specific.
export type OutcomeTier = "critical" | "success" | "partial" | "failure";

// Result shape — the hint vocabulary plus a raw mechanical record.
export interface MyToolResult {
  outcome_tier: OutcomeTier;
  pressure?: Pressure;
  salient_facts?: string[];
  suggested_beats?: SuggestedBeat[];
  roll: { rolls: number[]; total: number; notation: string };
  // Game-specific typed flags if needed — short snake_case names.
}

// The pure function. All mechanical logic here, threads rng everywhere.
export function myToolPure(
  args: MyToolArgs,
  rng: () => number = Math.random
): MyToolResult {
  const roll = rollDice("2d6", rng);
  const outcome_tier: OutcomeTier =
    roll.total >= 10 ? "success"
    : roll.total >= 7 ? "partial"
    : "failure";
  const pressure: Pressure =
    outcome_tier === "success" ? "falling"
    : outcome_tier === "partial" ? "rising"
    : "spiking";
  const suggested_beats: SuggestedBeat[] =
    outcome_tier === "success" ? ["advantage"]
    : outcome_tier === "partial" ? ["complication", "cost"]
    : ["setback", "escalation"];
  return {
    outcome_tier,
    pressure,
    suggested_beats,
    roll: { rolls: roll.rolls, total: roll.total, notation: roll.notation },
  };
}

// The MCP factory. Thin wrapper — no mechanical work.
export function createMyTool() {
  return tool(
    "tool_name",
    "Description of WHEN the facilitator should call this — narrative trigger.",
    {
      paramName: z.string().describe("What this parameter is for"),
      optionalParam: z.number().optional().describe("Optional"),
    },
    async (args) => {
      const result = myToolPure(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
      // Recoverable error: return { content: [...], isError: true } instead of throwing.
    }
  );
}
```

### Dual-channel output

Handlers return both `content: [{ type: "text", text: JSON.stringify(result) }]` and `structuredContent: result`. The `content` field is what the facilitator reads; the `structuredContent` is for logging / UI chrome. Both carry the same payload — easy to satisfy, just spread the pure function's return.

### Handler-is-thin rule

If you find yourself writing a `for` loop, an `if/else` branch, an arithmetic expression, or a primitive call inside the handler — stop, and move that logic into the pure function. The validator relies on the pure function being the complete picture of the mechanic. Handlers that do work undermine that.

---

## Server assembly

`server.ts` wires all tools into one MCP server. Stateful tools get their store(s) injected from here so the state is process-wide.

```ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "../lib/state/session-store.js";
import { InMemoryStepStore } from "../lib/state/step-store.js";
// import each tool factory...

export function createGameServer() {
  const session = new SessionStore();     // HP, resources, clocks — any persistent mechanical state
  const steps = new InMemoryStepStore();  // only if some tool is pausable
  return createSdkMcpServer({
    name: "game-name-here",
    version: "1.0.0",
    tools: [
      // createOneShotTool(session),
      // createPausableTool(steps),
    ],
  });
}
```

Only create a `SessionStore` if the game actually tracks persistent mechanical state. Only create an `InMemoryStepStore` if a tool is pausable. Don't over-provision.

---

## Pausable tools

Some mechanics aren't complete in one call. Think blackjack: deal the hand, ask "hit or stand?", wait, deal more or resolve. Think PbtA "10+: ask the GM a question" — the mechanic is *not done* until the player asks the question; narration before that is premature. Think push-your-luck rolls: after the initial result, the player decides whether to press on.

These use the **re-entrant state-machine pattern**. The facilitator calls the tool, gets `status: "awaiting_input"` with a prompt, ends its turn and surfaces the choice to the player. When the player responds, the facilitator calls the tool again with `phase: "continue"` and the player's response. The tool reloads its state from a step store, advances, and either loops or finishes.

### Why this shape, not a flag

A common temptation is to make the tool one-shot and have it return a flag like `ask_player_a_question: true`. The facilitator is supposed to read that flag and prompt the player on the next turn. In practice this fails — the flag gets absorbed into narration as flavour ("a moment of clarity washes over you…") and the mandated player input silently disappears. The mechanic becomes atmospheric rather than mechanical.

The pausable pattern structurally forces the pause. `status: "awaiting_input"` is a control-flow signal the facilitator's prompt contract tells it to handle as "stop narrating outcomes, present the choice, wait". The mechanic completes correctly because the tool refuses to complete until the player has contributed.

### The flow

```
1. Facilitator calls: { phase: "start", stepId }
   Tool creates initial state, stores it keyed by stepId, returns
   { status: "awaiting_input", stepId, prompt: "Hit or stand?" }

2. Facilitator sees awaiting_input → narrates the situation, asks the
   player the prompt, ends turn. No other tool calls this turn.

3. Player responds: "I'll hit."

4. Facilitator calls: { phase: "continue", stepId, action: "hit" }
   Tool reloads state, advances, returns either
   { status: "awaiting_input", ... } (loop to 2) OR
   { status: "done", output: finalResult } (tool deletes stepId)
```

`AskUserQuestion` does NOT work here — the SDK subprocess has no TTY and the tool silently fails. The turn-taking above replaces it: the facilitator's message IS the ask; the player's next message IS the answer. No special SDK features needed.

### Pure step function shape

```ts
import { InMemoryStepStore, type StepStore } from "../lib/state/step-store.js";

// Cross-turn state.
export interface BlackjackState {
  deck: string[];
  player: string[];
  dealer: string[];
}

// Inputs. "start" creates initial state; others advance it.
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
  // ... state machine logic using primitives for randomness ...
  throw new Error("example only");
}
```

### Handler shape

```ts
export function createBlackjack(store: StepStore) {
  return tool(
    "resolve_blackjack",
    "Drive one blackjack round. Call with phase='start' to deal. If the " +
    "result is status='awaiting_input', present the prompt to the player " +
    "conversationally and wait for their reply, then call this tool again " +
    "with phase='continue', the same stepId, and the player's action. " +
    "Repeat until status='done'.",
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
```

### Decision heuristic — is this mechanic pausable?

Read the sourcebook's description of the mechanic. Look for these phrasings in the description of what happens during resolution (not what triggers the mechanic):

- "the player **asks** …"
- "the player **chooses** …"
- "the player **declares** …"
- "the player **names** …"
- "ask **the GM** / the facilitator a question"
- "**pick** one of the following"
- "**describe** the …"
- "decide whether to **press on** / continue / stop"

If any of those appear in the resolution description, the mechanic is pausable. The player's contribution is not an effect or flavour — it's a step the mechanic completes through.

If the sourcebook only mentions "the player" in describing when the mechanic triggers ("when the player attacks", "when the player's clock fills"), and the resolution itself is mechanical (rolls, damage, outcome tiers), the mechanic is one-shot.

The test isn't the specific name of the move — it's whether correct resolution requires something from the player that can't be known in advance. If it does, pausable. If it doesn't, one-shot.

---

## Hint vocabulary

Tool returns carry structured signals, never prose. The facilitator agent owns narrative voice — any sentence a tool writes competes with the per-game facilitator prompt and usually loses: facilitators either paraphrase it (making the tool's effort wasted) or read it verbatim (overriding the intended tone). So tools classify; facilitators narrate.

### Required

**`outcome_tier`** — short game-defined enum on every tool return. Pick 2–5 values matching the mechanic:

- **PbtA-style move**: `critical | success | partial | failure`
- **d20 attack / check**: `hit | miss` (add `critical` if relevant)
- **Binary helper/assist**: `success | failure` — even binary mechanics get a tier, not a boolean. Cross-tool uniformity is the point.
- **Pure content generator** (random-table rolls with no success/failure concept): `outcome_tier: "generated"` as a uniformity tag. The field is still present so every tool has the same interface.

Every tool has this field. If you're tempted to omit it for a tool whose mechanic doesn't fit tiers, use `"generated"` and move on.

### Recommended

**`pressure`** — one of `Pressure`: `falling | held | rising | spiking`. How this outcome moves narrative tension. `spiking` for sudden jumps (a clock fills, a crisis triggers), `rising` when things tightened, `held` for no change, `falling` for relief.

**`salient_facts: string[]`** — 0–5 short tokens naming concrete state changes the facilitator must reflect. Use a `kind:entity:delta` shape: `"hp:pc:-3"`, `"clock:nightfall:+1"`, `"resource:torchlight:1"`, `"npc:captain_darcy:revealed"`. Don't dump full state snapshots.

**`suggested_beats`** — 0–3 values from the closed catalog `SuggestedBeat`: `complication | cost | escalation | revelation | opening | setback | advantage | reprieve`. Nudges the facilitator can weave in. Not mandates — the facilitator picks what fits.

### Shared types — import, don't redeclare

`Pressure` and `SuggestedBeat` are cross-game shared enums, defined once in the runner's `lib/hints/index.js`. Every tool file imports them:

```ts
import type { Pressure, SuggestedBeat } from "../lib/hints/index.js";
```

Redeclaring them per tool would drift. `OutcomeTier` stays local because its values are per-tool.

### Game-specific flags

Typed booleans or short strings for per-mechanic triggers: `critical_dice: 2`, `trigger: "counter-attack"`, `special_insight_granted: true`. Keep names snake_case and terse. Each one should represent a specific mechanical fact the facilitator's per-game prompt teaches it how to handle.

Note the distinction: a flag is fine for *signalling that something mechanical happened* (a bonus triggered, a threshold crossed). A flag is NOT sufficient for *something the player must now contribute*. That's pausable territory (see above).

### Example

```json
{
  "outcome_tier": "partial",
  "pressure": "rising",
  "salient_facts": ["goal_achieved", "cost_incurred"],
  "suggested_beats": ["complication", "cost"],
  "roll": { "rolls": [3, 5], "total": 8 }
}
```

The facilitator reads this and writes prose in the game's voice. A pulpy game gets a campy complication; a grim game gets a terse cost. Same hints, different narration.

---

## Trigger eval corpus

For each tool file you write (e.g. `tools/roll-action.ts`), write a sibling corpus at `evals/roll-action.triggers.json` — a JSON array of scene prompts used to measure whether the tool's **description** causes the facilitator to invoke it at the right times.

A tool description is prompt engineering, not documentation: it lives in the facilitator's system prompt and steers selection. The trigger-eval harness runs each prompt through a Claude agent with access to all the game's tools and checks whether the expected tool (or no tool) was called.

Write **≥8 should-trigger** and **≥8 should-not-trigger** prompts per tool. At least 2 of the negatives must be **near-misses** — prompts that sound adjacent to the tool's domain but shouldn't fire it. Near-misses are the valuable signal; trivial negatives ("write a haiku") don't test anything.

```json
[
  {
    "prompt": "I try to hack the alien security terminal while the guards are distracted.",
    "should_trigger": true,
    "note": "technology-based risky action"
  },
  {
    "prompt": "I take a moment to breathe and ready myself for the battle ahead.",
    "should_trigger": false,
    "note": "narrative beat, no mechanical uncertainty"
  },
  {
    "prompt": "I ask the warlord what she thinks of the Consortium.",
    "should_trigger": false,
    "note": "near-miss — diplomatic but low-stakes"
  }
]
```

Rules:

- Prompts are from the **player's** voice — first-person short sentences, what they'd type at the facilitator. Not facilitator narrations.
- 1–2 sentences each. Mid-scene is fine; no setup needed.
- Positives cover the full range of fiction the tool targets (different character types, different situations). Don't reword one scenario eight times.
- At least 2 near-miss negatives — prompts that almost-but-not-quite trigger the tool. For a "take risky action" tool, a near-miss is "I carefully set up my equipment before beginning" (preparation, not action).
- If the game has multiple tools, include negatives that should trigger a *different* game tool — that way the corpus measures greediness vs discipline.
- `note` is free text; include it so the orchestrator and humans can read the corpus.

---

## Common anti-patterns

Things that look reasonable and aren't. Most of these come from real regenerations where the tool-builder produced one of these and had to be corrected.

- **Handler doing mechanical work.** Calling `rollDice` directly in the handler and writing arithmetic there, instead of in the pure function. Breaks differential testing.
- **Redeclared `Pressure` / `SuggestedBeat`.** Shadow-typing them in each tool file. Import from `../lib/hints/index.js` instead.
- **Missing `outcome_tier`.** Tool returns a boolean or a number instead of a tier. Even binary mechanics need `outcome_tier: "success" | "failure"`. Pure generators use `"generated"`.
- **`full_description` / `summary` / `guidance` prose fields.** Tool returns a sentence the facilitator is supposed to read verbatim or rewrite. Drop these entirely. The tool emits tokens; the facilitator composes sentences.
- **Pre-interpolated sentences.** `full_description: \`${threat} wants to ${wants_to} the ${the}\``. Even when assembled from tokens, the sentence has a voice. Return the raw tokens and let the facilitator combine them.
- **Flag instead of pausable.** Tool returns `ask_player_a_question: true` or `player_must_declare_a_bond: true` on a one-shot tool. The flag gets absorbed. If the mechanic requires player input during resolution, it has to be pausable.
- **`Math.random` in pure function.** Always thread `rng` through. Direct `Math.random` calls kill differential testing and silently produce non-reproducible tests.
- **Tool description in mechanical terms.** "Roll 2d6 and compare to stat." No — the description steers the facilitator's selection by fiction. Write triggers like "Roll when a PC takes a risky technological action" — what's happening in the story.
