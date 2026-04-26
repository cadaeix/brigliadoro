# Tool Reference

Deep reference for building game tools. The tool-builder prompt points here for exact signatures, templates, and edge-case detail. Read the section you need; don't read the whole thing unless you're orienting.

## Contents

1. [Primitives API](#primitives-api) — signatures for dice, draws, resources, clocks, tables
2. [Tool file pattern](#tool-file-pattern) — pure function + thin handler, dual-channel output
3. [Server assembly](#server-assembly) — `server.ts` shape, store injection
4. [Pausable tools](#pausable-tools) — for mechanics that need player input mid-resolution
5. [Cross-tool resource pipelines](#cross-tool-resource-pipelines) — when one tool generates a resource another tool consumes
6. [Cascading and conditional rolls](#cascading-and-conditional-rolls) — chained rolls with dedup / substitution / branching
7. [Source fidelity for tables and vocabulary](#source-fidelity-for-tables-and-vocabulary) — transcribe, don't re-theme
8. [Hint vocabulary](#hint-vocabulary) — what tool returns carry
9. [Trigger eval corpus](#trigger-eval-corpus) — the `.triggers.json` format
10. [Manifest](#manifest) — the `tools/manifest.json` you write declaring what you built and why
11. [Anti-patterns index](#anti-patterns-index) — cross-references to where each anti-pattern is treated

---

## Primitives API

Import from the runner's local lib: `import { rollDice, drawFromPool, ... } from "../lib/primitives/index.js";`

Types live at `../lib/types/index.js`.

Every RNG-touching primitive accepts an optional `rng: () => number = Math.random` as its last parameter. Pure functions that transitively call these must accept their own `rng` and thread it through — this is how differential testing works. Never call `Math.random` directly in a pure function.

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

For TTRPG-style random tables — "roll 1d20 on Wilderness Encounter, 1-10 nothing, 11-15 lost traveller…". Conceptually distinct from `drawFromPool`: tables have explicit ranges mapped to entries.

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

A common temptation: keep the tool one-shot and have it return a flag like `ask_player_a_question: true`. The facilitator is supposed to read the flag and prompt the player on the next turn. In practice it fails — the flag gets absorbed into narration as flavour ("a moment of clarity washes over you…") and the mandated player input silently disappears. The mechanic becomes atmospheric rather than mechanical.

The pausable pattern structurally forces the pause. `status: "awaiting_input"` is a control-flow signal the facilitator's prompt contract tells it to handle as "stop narrating outcomes, present the choice, wait." The mechanic completes correctly because the tool refuses to complete until the player has contributed.

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

If any appear in the resolution description, the mechanic is pausable. The player's contribution is not an effect or flavour — it's a step the mechanic completes through.

If "the player" only appears in describing when the mechanic triggers ("when the player attacks", "when the player's clock fills"), and the resolution itself is mechanical (rolls, damage, outcome tiers), the mechanic is one-shot.

The test isn't the specific name of the move — it's whether correct resolution requires something from the player that can't be known in advance. If yes, pausable. If no, one-shot.

---

## Cross-tool resource pipelines

When several tools touch the same resource — one accrues, one spends, one reads — they communicate implicitly through `SessionStore`. That coordination is invisible in per-tool unit tests: each tool can pass its own tests in isolation while the integration is silently broken. The failure plays out like this: the generating tool returns the per-call delta in its hints and considers its job done. The consuming tool reads the session resource, finds zero, reports "insufficient." Tests stay green; play-time, nothing works.

A tool returning "I generated 2 of resource X" is a statement about *this call*; the session resource for X is the running total across the whole session. Both need to exist.

### The practice

Any handler that *generates* a shared resource reads the current session value, adds the delta, writes the new total. Any handler that *consumes* reads, validates, writes the decremented total. Both sides must agree on the `(entity, key)` indexing.

If you catch yourself thinking "the facilitator will see the marker count in the hint and pass it to the consumer," stop: the consumer's handler never sees hints from a different call. Session state is the only channel between tools.

<examples>
<example name="accrue-and-spend pair">
A combat tool that grants stress on partial successes, and a separate push-roll tool that spends stress.

The combat handler, after computing the pure result, persists the gain:
`const current = session.getResource(pcName, "stress")?.value ?? 0; session.setResource(pcName, "stress", current + delta, {...});`

The push-roll handler reads from the same `(pcName, "stress")`, validates, writes the decremented value.

The generating tool's return still carries `stress_gained: 1` for the facilitator's narration; the session resource carries the total. Both exist.
</example>

<example name="multiple generators, single consumer">
Three tools feed a "doom track": travel-encounter, failed-investigation, ritual-interruption. A single end-of-scene tool checks the track and triggers apocalypse beats at thresholds.

Each generator does the read-add-write against `("campaign", "doom")`. The checker reads and compares. Even when generators are independent, they all agree on the `(entity, key)` and they all persist.
</example>

<example name="pausable tool with mid-flow resource effect">
A pausable resolution tool accrues tokens during its flow. Mid-flow, the player can elect a reward that wipes one of those tokens. The pure function tracks both: tokens accumulated, and whether wipes were selected.

When the handler's `done` branch returns, it computes the net effect on session state: add the accumulated tokens, subtract the wipes, write the result. *Not* "add the tokens and trust the facilitator to remember the wipe next turn."
</example>
</examples>

The same discipline applies *within* a single tool that branches between "this conceptually changes resource X" outcomes. If the pure function decides "this branch implies resource X changes by N," the handler must `session.setResource` that change before returning. The hint tells the facilitator what to narrate; the session write makes it true.

### The trace before handing off

List every resource name appearing across more than one tool, plus any resource a single tool both increases and decreases within its own flow. For each: does every branch that conceptually changes it persist? Do all readers use the same `(entity, key)`? Is the shape (scalar / min / max) consistent across writers? Per-tool tests don't catch this — trace it yourself.

---

## Cascading and conditional rolls

Some mechanics chain rolls with rules that govern how one roll affects another: re-rolling on duplicates, substituting outcomes, branching to a different table based on the first result, modifying the second roll using the first. **These rules are part of the mechanic — not narrative colour.** When they're left for the facilitator to "apply in narration," they drift across sessions, get forgotten at table-joining moments, or get applied inconsistently. A tool that structurally encodes the rule runs the mechanic the same way every time.

### The practice

When you read a mechanic involving more than one roll, list the inter-roll rules explicitly. Each rule becomes a branch in a pure function, a tool parameter, or (if the player must contribute between rolls) a phase in a pausable state machine. Rules you *don't* encode become rules the facilitator improvises.

<examples>
<example name="dedup with substitute">
Source: "Roll 1d8 on the Spirit Court table to determine your patron. Roll 1d8 again on the same table to determine who wronged them. If the second roll matches the first, substitute 'the Sovereign Below' instead."

Shape: a tool that rolls the same table with an `exclude` parameter naming the prior result. Pure function: roll, compare, substitute if equal, return. The facilitator calls once for the patron (no `exclude`), calls again for the wronging party (passing the patron's result as `exclude`). No narration-driven logic.
</example>

<example name="conditional branch to another table">
Source: "Roll 1d20 for the wilderness encounter. On a 17–20, roll 1d8 on the Monstrous Encounters sub-table."

Shape: this is what `rerollOnto` on `Table<T>` entries handles natively — the primary table's 17–20 entry points to the sub-table via `rerollOnto`, and `rollOnTable` returns the leaf entry with the chain recorded. Check the `rollOnTable` primitive section before hand-rolling cascade logic.
</example>

<example name="dependent modifier from a prior roll">
Source: "Roll 1d6 for your starting Affliction. The number you rolled is your Weakness score. Then roll 2d6 + Weakness on the Hauntings table to see what follows you."

Shape: a pure function that takes the first roll's result as an input parameter to the second roll. The facilitator calls the first tool, gets a score, passes it as an explicit arg to the next. The dependency is visible in the tool's signature, not left to facilitator memory.
</example>

<example name="ordered rolls with player input between">
Source: "Roll 2d6. Show the player the result. If they want, they can spend a Favour to re-roll one die before committing."

Shape: pausable tool. Phase 1: roll, return the dice, pause with `status: awaiting_input` and a prompt. Phase 2: accept the player's decision (re-roll which die, or commit) and resolve. The cascade is modelled as phases, not as two separate tools the facilitator chains by hand.
</example>
</examples>

The test: if a rule lives only in the facilitator prompt, can you imagine a plausible turn where the facilitator skips or misapplies it? If yes, move the rule into the tool.

### The characterCreation mirror

When the source has multi-step setup with inter-roll rules — dedup, conditional re-rolls, result-dependent modifiers — the characterizer's `characterCreation.steps` should list each step and name each rule. The tool-builder's `roll_situation` (or whatever name) should expose each step as a distinct shape (table_type, parameter, phase). If `characterCreation` lists N steps and the tool only exposes M < N shapes, the facilitator is missing the handles it needs to drive setup; that mismatch is a bug either way.

---

## Source fidelity for tables and vocabulary

Random-table entries carry the game's voice. When a facilitator rolls in play, the entry text flows directly into the fiction — the player never reads the source, but they feel the wording through the facilitator's narration. Re-themed entries silently replace the designer's voice with yours. The game you generate stops being the game you were given.

Apply this to **every** table — not just the ones whose entries look obviously "flavorful." A d6 list of weapon names, a dry table of weather conditions, and a voicey table of NPC motivations are all source voice. Plain-looking tables often do the most character-establishing work precisely because they're unshowy.

### The practice

Keep the source open beside you when transcribing. Copy each entry's wording as closely as TypeScript string literals allow — vocabulary, slang, POV, capitalisation quirks. Don't work from memory; memory improvises. Don't paraphrase for compactness; paraphrase IS improvisation.

<examples>
<example name="dry mechanical table">
Source: "Mishaps while climbing (1d6): 1. Rope frays. 2. Handhold crumbles. 3. Equipment slips. 4. Partner's weight shifts. 5. Sudden wind gust. 6. Piton pulls out of rock."

Good: entries copied verbatim, including parallel phrasing and d6 shape.

Bad: summarised as "1. Rope / 2. Rock / 3. Gear / 4. Partner / 5. Wind / 6. Anchor" — same semantic domain, lost specificity.
</example>

<example name="voicey slang table">
Source: "What the old woman mutters as you pass (1d6): 1. Don't drink the river's water tonight. 2. He was never your father. 3. Three of you leave, two of you come back. 4. The moon owes me. 5. Tell it you're sorry — IT'S LISTENING. 6. [long stare, no words]"

Good: entries preserved verbatim including the ALL-CAPS in entry 5 and the bracketed stage direction in entry 6. The caps and the silence are mechanics — the facilitator narrates them differently than calm prophetic text.

Bad: "1. A warning about water. 2. A revelation about parentage. 3. A prophecy about a journey." — semantically equivalent, voice-wise a different game.
</example>

<example name="table with embedded sub-mechanics">
Source: "On a failed recovery roll, roll 1d8 for complication: 1. Blood loss (-1 HP per round until stabilised). 2. Broken bone (disadvantage on physical rolls). 3. Delirium (GM controls next action). ..."

Good: mechanical riders stay attached to the entry text — "Blood loss (-1 HP per round until stabilised)" is one string, not split into bare names + separate rider.

Bad: riders dropped as "flavor"; entries become bare names. The game's consequences disappear.
</example>
</examples>

The common failure: transcribing one table faithfully (often the one that looked obviously voiced) and inventing entries for others that looked "generic enough to improvise on." All tables are source-fidelity territory. The test: can you point at the source page and say "the entry I wrote came from here"? If not, you're inventing.

### Narrow carve-outs for adaptation

- The entry references a physical-medium affordance that can't translate to text chat (pass-the-dice ritual, card-flip-under-the-table). Adapt the affordance; preserve the entry's semantic function.
- The entry names a person/place/item the source itself never defines. Leave a clearly-labelled placeholder the facilitator fills at play time; don't invent specifics.
- The source table has genuine internal contradiction (rare). Resolve toward the reading that preserves the mechanic's role.

---

## Hint vocabulary

Tool returns carry structured signals, never prose. The facilitator agent owns narrative voice — any sentence a tool writes competes with the per-game facilitator prompt and usually loses: facilitators either paraphrase it (wasting the tool's effort) or read it verbatim (overriding the intended tone). So tools classify; facilitators narrate.

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

Typed booleans or short strings for per-mechanic triggers: `critical_dice: 2`, `trigger: "counter-attack"`, `special_insight_granted: true`. Keep names snake_case and terse. Each one represents a specific mechanical fact the facilitator's per-game prompt teaches it how to handle.

A flag is fine for *signalling that something mechanical happened* (a bonus triggered, a threshold crossed). A flag is NOT sufficient for *something the player must now contribute* — that's pausable territory.

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
- At least 2 near-miss negatives — prompts that almost-but-not-quite trigger. For a "take risky action" tool, a near-miss is "I carefully set up my equipment before beginning" (preparation, not action).
- If the game has multiple tools, include negatives that should trigger a *different* game tool — that way the corpus measures greediness vs discipline.
- `note` is free text; include it so the orchestrator and humans can read the corpus.

### Distribution discipline

Hitting the count requirement (≥8 positives) is necessary but not sufficient. **Positives must sample across the *shape* of trigger cases the tool covers, not cluster on one *flavor*.**

The facilitator at play time doesn't reason about the rule defining when your tool should fire — it pattern-matches against the examples you give it. If all your positives share keywords (specific NPC names, specific equipment, specific locations, specific genre-flavoured situations), the facilitator learns "this tool fires for *that genre*" rather than "this tool fires for *that condition*." Anything outside the genre slice gets missed at play time, and the player has to manually prod the facilitator into rolling.

Concrete failure: a "risky action" resolver tested with 10 positives all naming the same gang's NPCs and equipment (intimidating Selkie, driving the Cadillac, swinging at Mad Dog). At play time, the facilitator never called the tool when the PC sat down at a friendly poker game and bluffed a stranger — even though that's a textbook risky-uncertain action. The genre keywords had taught the wrong lesson.

Practice: before drafting positives, list the *categories of trigger* this tool should fire across. For a risky-action resolver in a crime game:

- physical-violent (combat, intimidation with force)
- social-deceptive (bluffing, lying, conning, charm offensive)
- low-stakes-uncertain (gambling, pickpocketing, swiping things, small lies)
- skilled-under-pressure (lockpicking, fast-driving, hacking)
- supernatural-perception (reading auras, sensing the wrong)
- bargaining-with-stakes (negotiating with someone who can hurt you)

Write at least one positive per category that's plausible in this game's fiction. If a category has no plausible positive, leave it out — but make the omission deliberate.

Mix the genre markers across positives — no two positives should name the same NPC, the same weapon, the same location. Force yourself away from clusters.

---

## Manifest

After you've written all tool files and assembled `server.ts`, you write `tools/manifest.json` — a structured declaration of what you built and (critically) what source rules text justifies each tool. The orchestrator's verification step reads this in place of ad-hoc parsing of your `.ts` files; the coherence auditor (when it runs) reads it as the primary input for source-grounding checks.

The manifest's `source_ref.quote` field is the single most important discipline this artefact enforces. Every tool you wrote must be accompanied by a verbatim quote from the source's *rules text* (not source fiction) supporting its existence. If you can't produce one, the tool is probably invented; remove it. If two tools quote the same rules text, they're probably one mechanic split into two; consolidate.

### Schema

```ts
interface ToolManifest {
  game_name: string;       // matches config.json's name
  version: 1;              // schema version
  tools: ToolManifestEntry[];
}

interface ToolManifestEntry {
  name: string;            // MCP tool name, snake_case (first arg to tool())
  file: string;            // relative path inside tools/, e.g. "primary-action.ts"
  description: string;     // exact description string passed to tool() — what steers facilitator selection
  params: Record<string, string>;  // param name → short description
  outcome_tiers: string[]; // exact OutcomeTier values; ["generated"] for content generators
  flags: string[];         // game-specific flags returned (snake_case); empty if none
  shape: "one-shot" | "pausable";
  resources_emitted: string[];  // session resources this tool writes; empty if none
  resources_consumed: string[]; // session resources this tool reads; empty if none
  source_ref: {
    summary: string;       // 1-line: what source mechanic this tool models
    quote: string;         // verbatim source rules text justifying the tool; may be "" only in narrow structural cases
    page_or_section?: string;  // optional locator
  };
}
```

### Example

A minimal manifest for a hypothetical PbtA-style game with one resolution move and one stat-change utility:

```json
{
  "game_name": "Example Game",
  "version": 1,
  "tools": [
    {
      "name": "act_under_pressure",
      "file": "act-under-pressure.ts",
      "description": "Roll when a PC takes action while threatened or rushed — anything where success is uncertain and failure has teeth.",
      "params": {
        "stat_modifier": "The +/- modifier from the relevant stat for this action."
      },
      "outcome_tiers": ["strong_hit", "weak_hit", "miss"],
      "flags": ["complication_triggered"],
      "shape": "one-shot",
      "resources_emitted": [],
      "resources_consumed": [],
      "source_ref": {
        "summary": "The game's universal action move — 2d6 + stat, 10+ strong hit, 7-9 weak hit, 6- miss.",
        "quote": "When you act under pressure, roll +stat. On a 10+, you do it without complication. On a 7-9, you do it but the GM picks one: it costs you, it's incomplete, or there's a downside. On a 6-, the GM makes a hard move.",
        "page_or_section": "Core Move, p. 14"
      }
    },
    {
      "name": "spend_focus",
      "file": "spend-focus.ts",
      "description": "When a PC spends a Focus point to push through exhaustion, fear, or distraction.",
      "params": {
        "pc_name": "Name of the PC spending Focus.",
        "amount": "How many Focus points to spend (usually 1)."
      },
      "outcome_tiers": ["success", "failure"],
      "flags": [],
      "shape": "one-shot",
      "resources_emitted": [],
      "resources_consumed": ["focus"],
      "source_ref": {
        "summary": "Focus is a spendable PC resource that the PC can burn to overcome certain conditions.",
        "quote": "You may spend 1 Focus to ignore the next negative consequence imposed on you this scene.",
        "page_or_section": "Resources, p. 22"
      }
    }
  ]
}
```

### Filling the source_ref honestly

The temptation is to fill `source_ref.quote` with whatever's vaguely related — a fiction passage, a flavour blurb, a GM tip. That defeats the purpose. The quote must be **mechanical text the source uses to define a rule**, not narrative or atmospheric text.

What counts as rules text:
- Numbered move descriptions, action procedures, resolution flows
- Threshold tables ("on a 10+ … on a 7-9 … on a 6 or less …")
- Resource definitions with mechanical effects ("each point of X lets you do Y")
- Procedural sequences ("when X happens, do Y, then Z")

What does NOT count:
- Fiction examples ("Sara rolls to climb the wall, the GM narrates…")
- World-building prose
- Designer commentary or play advice
- "When two characters fight, things get tense" — unless followed by a distinct mechanical procedure

If a tool's source_ref.quote is a fiction passage rather than rules text, the tool is built on the wrong foundation. Either find rules text that justifies the same mechanic, or recognise the tool is invented and remove it.

### Empty quote — narrow legitimacy

A handful of tools genuinely have no source-rule counterpart: rare structural utilities (a `start_session` housekeeping tool, a `summarise_state` debug helper). When you have one of these, leave `quote` empty and explain *in `summary`* why no rules text applies. A reviewer should see this and either accept it or push back. Treat empty quote as a flag, not a free pass.

---

## Anti-patterns index

Cross-references to where each anti-pattern is treated in this document. If you've found yourself doing one of these, follow the link for the deep treatment.

- **Handler doing mechanical work** — calling primitives or doing arithmetic in the handler instead of the pure function. Breaks differential testing. → [Tool file pattern](#tool-file-pattern), Handler-is-thin rule.
- **Redeclared `Pressure` / `SuggestedBeat`** — shadow-typing them in each tool file. → [Hint vocabulary](#hint-vocabulary), Shared types.
- **Missing `outcome_tier`** — tool returns a boolean or number instead of a tier. → [Hint vocabulary](#hint-vocabulary), Required.
- **Prose fields in returns** (`full_description`, `summary`, `guidance`, pre-interpolated sentences) — tool tries to do the facilitator's narration job. → [Hint vocabulary](#hint-vocabulary).
- **Flag instead of pausable** — `ask_player_a_question: true` on a one-shot tool. The flag gets absorbed; mid-resolution player input is lost. → [Pausable tools](#pausable-tools), Why this shape.
- **`Math.random` in pure function** — kills differential testing. Always thread `rng`. → [Primitives API](#primitives-api).
- **Tool description in mechanical terms** — "Roll 2d6 and compare to stat" instead of a fictional trigger. → [Trigger eval corpus](#trigger-eval-corpus) and the tool-builder Step 5.
- **Unpersisted resource pipeline** — generator returns the delta but never writes session state; consumer reads zero. Per-tool tests pass; integration silently broken. → [Cross-tool resource pipelines](#cross-tool-resource-pipelines).
- **Unmodeled cascading-roll logic** — chained rolls with dedup / substitution / branching expressed in narration instead of tool code. The rules drift. → [Cascading and conditional rolls](#cascading-and-conditional-rolls).
- **Table-entry reframing** — re-themed or paraphrased entries replace the source's voice. → [Source fidelity for tables and vocabulary](#source-fidelity-for-tables-and-vocabulary).
- **Invented mechanics** — adding a tool for a mechanic the source doesn't distinguish. Creates selection ambiguity against the general tool. → tool-builder Step 2.
- **Split mechanic across tools** — taking one source-level resolution and splitting it into two coordinating tools. The facilitator threads data and juggles competing descriptions. → tool-builder Step 2.
- **Eval-corpus genre clustering** — 8+ positives all naming the same NPCs / equipment / locations. Facilitator learns the genre instead of the trigger condition. → [Trigger eval corpus](#trigger-eval-corpus), Distribution discipline.
