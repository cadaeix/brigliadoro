# Testing Reference

Deep reference for writing tests against generated game tools. The validator prompt points here for exact test patterns and RNG mapping detail.

## Contents

1. [Test helpers](#test-helpers) — seeded RNGs from `lib/test-helpers`
2. [RNG → dice mapping](#rng--dice-mapping) — forcing specific dice outcomes
3. [Gate 1: differential test](#gate-1-differential-test) — mandatory for RNG-touching tools
4. [Scenario tests](#scenario-tests) — per-outcome-tier coverage
5. [What to test for each tool](#what-to-test-for-each-tool)

---

## Test helpers

The runner's lib ships two deterministic RNGs:

```ts
import { seededRng, sequenceRng } from "../lib/test-helpers/index.js";
```

- **`seededRng(seed: number)`** — a Mulberry32 PRNG. Deterministic for a given seed, uniform in `[0, 1)`. Use for bulk tests where you don't care about specific dice values, only that the tool's output matches a primitive-direct call with the same seed.
- **`sequenceRng(values: number[])`** — returns the given values in order, cycling when exhausted. Use when you need to force specific dice results for scenario coverage.

Also useful:

```ts
import { describe, it, expect } from "vitest";
import { rollDice } from "../lib/primitives/index.js";  // for Gate 1 oracle
import { myToolPure } from "../tools/my-tool.js";
```

---

## RNG → dice mapping

The primitives convert `[0, 1)` RNG values to dice results using `Math.floor(rng() * sides) + 1`.

- For a d6: `0.0` → 1, `0.166` → 1, `0.167` → 2, `0.5` → 4, `0.833` → 5, `0.999` → 6
- For a d20: `0.0` → 1, `0.95` → 20

General formula: to force dice result `d` on an N-sided die, feed RNG value `(d - 1) / N`. For safety (floating-point jitter), feed `(d - 1) / N + 0.001` or round up slightly.

Shortcut: `sequenceRng([0.0, 0.999])` on a 2d6 roll yields `[1, 6]`. Useful for covering min/max scenarios.

---

## Gate 1: differential test

**Mandatory for any tool whose pure function calls an RNG primitive.** This catches wrapper bugs: lost rolls, reordered rolls, double-consumed rolls, sign errors, off-by-ones.

The shape: seed the tool's pure function with a deterministic RNG, seed the primitive directly with the same RNG, and assert the raw mechanical fields are identical.

```ts
describe("my_tool differential gate", () => {
  it("rolls match direct primitive for 100 seeds", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const viaTool = myToolPure({ paramName: "x" }, seededRng(seed));
      const viaPrim = rollDice("2d6", seededRng(seed));
      expect(viaTool.roll.rolls).toEqual(viaPrim.rolls);
      expect(viaTool.roll.total).toEqual(viaPrim.total);
    }
  });
});
```

Writing the test:

1. Read the pure function's source to identify the primitive call(s).
2. For each seed, call the pure function with `seededRng(seed)` and call the primitive directly with `seededRng(seed)` using the same notation / args.
3. Assert equality on the raw mechanical fields — dice rolls, drawn items, etc.
4. Do NOT assert on interpreted fields like `outcome_tier` in the differential test — that's scenario-test territory.
5. If the tool makes multiple primitive calls (rolls AND draws), extend the assertions to cover each, in the order they appear in the pure function.

Tools that touch NO RNG primitive (resource ops, clock ops only) skip Gate 1 — they're already deterministic.

### Gate 1 for pausable tools

Step functions are differentially testable too — seed an RNG, drive a canonical input sequence, assert state transitions match primitive-direct equivalents. Iterate over the sequence:

```ts
it("dealt cards match direct primitive draws for seeded sequences", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const step = blackjackStep(null, { kind: "start" }, seededRng(seed));
    // Drive a direct drawFromPool with the same seed, assert the initial
    // cards match. Then advance with { kind: "hit" } and keep asserting.
  }
});
```

---

## Scenario tests

For each outcome tier the tool produces, hand-craft an RNG sequence that forces that tier and assert the interpretation:

```ts
describe("my_tool outcomes", () => {
  it("yields failure when dice total is low", () => {
    const result = myToolPure({ paramName: "x" }, sequenceRng([0.0, 0.0]));
    expect(result.outcome_tier).toBe("failure");
  });

  it("yields partial on a mid roll", () => {
    // 2d6 → [3, 4] = 7 on the boundary
    const result = myToolPure({ paramName: "x" }, sequenceRng([0.333, 0.5]));
    expect(result.outcome_tier).toBe("partial");
  });

  it("yields success when dice total is high", () => {
    const result = myToolPure({ paramName: "x" }, sequenceRng([0.999, 0.999]));
    expect(result.outcome_tier).toBe("success");
  });
});
```

Cover at least one test per outcome tier. If the tool has a `critical` tier or a game-specific flag (e.g. `special_insight_triggered`, `critical_hit`), add a test forcing that branch too.

---

## What to test for each tool

Minimum coverage per tool:

- **Gate 1 differential** — if any RNG primitive is used. 100 seeds is the standard; more is fine.
- **Outcome tiers** — one scenario test per tier (`critical`, `success`, `partial`, `failure` for a PbtA move; `hit` / `miss` for a d20 attack; whatever the tool uses).
- **Edge cases** — boundary values (dice totaling exactly the tier-threshold), optional parameters, special-trigger branches.
- **Structured hint fields present** — assert `outcome_tier` is set on every return, and that `pressure` / `salient_facts` / `suggested_beats` match the documented behaviour.

For pausable tools, also:

- **Step sequence** — drive `start` → `continue` → `continue` → … and assert state transitions at each step.
- **Awaiting vs done** — assert the `kind` of each step. `awaiting` must come with a non-empty `prompt`; `done` must come with a `result`.
- **Store interaction** — if you're testing the handler (not just the step function), use an in-memory store and assert it's populated after `awaiting` and deleted after `done`.

## Test-fix loop

After writing, run:

```
npx vitest run <runner-dir>/tests/
```

If something fails:

1. Read the error carefully.
2. Is the failure in the test code or the tool code?
3. Test bug → fix the test, re-run.
4. Tool bug → do NOT modify the tool. Describe the bug clearly and report it back. Include the tool name, expected behaviour, actual behaviour, and the seed / RNG sequence that triggered the failure.

Up to 3 test-fix iterations is normal. If you're hitting iteration 4, something deeper is wrong — report it.
