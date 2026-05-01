# CLAUDE.md

Brigliadoro is a harness that reads TTRPG sourcebooks and generates **runners** — self-contained directories where a Claude agent facilitates a game alongside a human player. Read README.md and `user-project-plan.md` for the long story.

## Mental model (load-bearing)

**Mechanics → tools. Bookkeeping → specialist subagents. Narrative → the facilitator agent.**

The facilitator's attention is reserved for voice, pacing, and fiction. Anything that competes with that attention is pushed elsewhere:

- Mechanics live in tools (primitives + generated game tools). The facilitator never does dice math.
- Bookkeeping lives in Haiku subagents (currently the bookkeeper, owning writes to typed memory books). Specialists are spawned per turn boundary or on demand, fresh `query()` per invocation, scoped tool access.
- Narrative lives in the facilitator. It picks tools by fiction, reads structured hints, writes prose in the per-game voice set by the characterizer.

"Facilitator" is the unified internal role. Per-game in-game role names (GM, Lens, Cardinal, Host, fellow player) are picked by the characterizer and live in `config.facilitatorPrompt`.

## Three-layer tool model

1. **Primitives** (`src/primitives/`) — pure mechanical operations, hand-written. Clean obvious API surface so generated code calls them reliably.
2. **Generated game tools** — bespoke MCP tools the tool-builder writes per game. Each wraps primitives, encodes a narrative trigger, classifies results into the structured hint vocabulary, and ships with a trigger-rate eval corpus.
3. **Facilitator agent** — operates at the fiction layer only. Sees structured hints, never raw mechanics.

Hint vocabulary: `outcome_tier`, `pressure`, `salient_facts`, `suggested_beats`, plus raw mechanical record. No prose fields like `guidance` or `narration` — voice belongs to the facilitatorPrompt.

## Agent topology

```
Brigliadoro Orchestrator (Sonnet; --models quality uses Opus)
├── tool-builder      — game tools + triggers.json eval corpus
├── characterizer     — facilitator style, facilitatorPrompt, lore, setup config
└── validator         — differential + scenario tests, runs them, fixes failures
│
▼ (generated runner directory)
Runner (orchestrated by play.ts)
├── Facilitator agent (Sonnet; plays the in-game role chosen per game)
└── Bookkeeper subagent (Haiku; spawned after each facilitator turn)
```

Future specialists (continuity-checker, lore-spelunker, session-recap-writer, safety-monitor) follow the bookkeeper pattern. Add one at a time, driven by observed gaps in play.

Model rationale: Opus for taste/judgment, Sonnet for bulk codegen, Haiku for cheap repetitive parsing.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — vitest, all tests
- `npm run test:watch` — watch mode
- `npx vitest run tests/primitives/dice.test.ts` — single file
- `npm run generate -- "path/to/sourcebook.pdf" runner-name` — generate a runner
- `npm run play -- runners/<name>` — play a generated runner

## Tech stack

TypeScript on Node.js 18+. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for agent orchestration. Custom tools as in-process MCP servers via `createSdkMcpServer()` + `tool()`. Vitest for testing. Knowledge base via glob/grep, not RAG/vector. Terminal-first; HTML/CSS UI later.

## Where things live

- `src/primitives/` — see `.claude/rules/primitives.md` when working here
- `src/meta/prompts/` — generator subagent prompts; see `.claude/rules/tool-builder.md`
- `src/runner/` — runtime harness; see `.claude/rules/runner.md`
- `tests/`, `*.test.ts` — see `.claude/rules/testing.md`
- `~/.claude/plans/brigliadoro-*.md` — design plans for in-flight work; grep when picking up related threads. New plans get the `brigliadoro-` prefix.

## Rules

- **Open source / Creative Commons only in public-facing material.** PbtA as a framework name is fine; specific proprietary game titles are not. Applies to CLAUDE.md, README, commits, prompt examples.
- **Warn before runner regen if it would destroy in-progress play state** — session-id, scratchpad, populated memory books. Regen itself is cheap (subscription rate limits, not paid API), so default to regen for generator-contract changes — but data loss requires explicit acknowledgement.
- **Commit per discrete feature.** When a pick completes and tests go green, that's a commit-worthy moment. Surface "ready to commit?" at natural breakpoints rather than rolling into the next task.
  **LLM-as-player and persona frameworks are deliberately outside Brigliadoro.** The player-input hooks are intentionally generic. Persona prompts, agentic-player runners, eval harnesses, and anecdata scenarios belong in a sister space (user-level prompt frameworks, Claude Code skills, or a separate repo) — not inside the project. Brigliadoro is a facilitator generator; a player-side subsystem would muddle that story. Design at `C:\Users\Cad\.claude\plans\brigliadoro-llm-player-harness.md`.
