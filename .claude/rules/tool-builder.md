# Tool builder & generator rules

Loads when working in `src/meta/prompts/` or on generated tool code.

## Pausable pattern is the working shape for mid-resolution player input

Any mechanic whose correct resolution requires something from the player (a question, a choice, a declared fact) uses the state-machine + StepStore pattern (phase: "start"/"continue"). Flags on one-shot tools silently get absorbed into narration and the mechanic decomposes. There is no AskUserQuestion fallback — pausable is the only working shape.

## Hint vocabulary contract

Every tool return has `outcome_tier` (with a `"generated"` carve-out for pure content generators). No prose fields — `guidance`, `narration`, `full_description` and similar are forbidden. Shared hint types live in `src/hints/`. The per-game facilitatorPrompt is the single source of narrative voice; tools deliver structured signals, not prose.

## Subagent prompt discipline

Workflow-shaped: read sourcebook → inventory mechanics → classify one-shot vs pausable → write → review. Deep reference material (signatures, templates, edge cases) lives in `src/meta/prompts/references/*.md` and is loaded by the subagent on demand. Modelled on Anthropic's skill-creator SKILL.md pattern.

Explaining _why_ (theory-of-mind framing) generalises better than shouting `MUST` / `NEVER`. If a rule keeps getting violated, that's usually a sign the prompt needs better explanation, not louder emphasis.

## Tool-builder reference index

`src/meta/prompts/references/tool-reference.md` covers cross-tool resource pipeline, intra-tool resource effect discipline, cascading/conditional rolls, and source fidelity for tables. Read it before non-trivial tool generation work.

`src/meta/prompts/references/testing-reference.md` covers test patterns the validator subagent uses.

## Orchestrator discipline

- Outcome-tier extraction must happen.
- Tool ↔ characterizer coherence cross-checks (if the characterizer says GMless, tools should not assume GM authority).
- Orphan-tool-file detection (tools generated but never referenced).
- Verbatim-passing carve-out for fidelity-critical content (rules text where paraphrase would distort).

## Eval corpus discipline

Trigger-eval positives must distribute across categories of trigger condition, not cluster on one genre. A combat-only positive set will not catch a tool that spuriously fires in social scenes.
