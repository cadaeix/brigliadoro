# Primitives rules

Loads when working in `src/primitives/`.

## Clean API surface is the load-bearing constraint

Primitives are called by generated TypeScript code that the tool-builder subagent writes. The tool-builder's success rate is directly proportional to how obvious and simple the primitive API is. A clever primitive API loses generation reliability faster than it gains expressiveness.

Concretely:

- Function names should be self-describing (`rollDice`, `drawFromPool`, `weightedPick`, `rollOnTable`, resource and clock ops).
- Argument shapes should be flat and predictable. Avoid optional config objects with many fields when two named functions would do.
- Return shapes should be uniform within a primitive family (all dice ops return the same kind of result object).
- Do not add convenience wrappers that the tool-builder might confuse for the underlying primitive.

## Primitives are pure

No I/O, no global state, no time-dependent behavior beyond `Math.random` (which is monkey-patched by `--seed` for determinism). If a primitive needs persistence, it doesn't belong in primitives — it belongs in the runner harness.

## Universal mechanics live here

Clocks/progress meters are universal — the facilitator should use them regardless of whether the source TTRPG includes them. Same for resource tracking. New universal mechanics can be added as primitives if they generalize across game types; one-off mechanics belong in generated game tools.

## Don't break the contract for generated runners

Existing runners depend on primitive signatures. If a primitive needs to change, prefer adding a new function over modifying the old one's signature; mark the old one deprecated and migrate over time. Generated runners are not regenerated for primitive-only changes unless explicitly needed.
