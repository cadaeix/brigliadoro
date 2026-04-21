# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Brigliadoro** is a harness that uses Claude (or another LLM) to create tools and lore from TTRPG sourcebooks, then generates a **Bespoke TTRPG Runner** — a game where an LLM acts as facilitator (GM, Lens, or whatever in-game role the game uses) and a human plays through a skinned text UI. "Facilitator" is the internal umbrella term: some games cast the role as a classic GM with full narrative authority; some cast it as a fellow player in a GMless structure; the characterizer picks which per game.

`user-project-plan.md` contains the original vision document.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — run all tests (vitest)
- `npm run test:watch` — run tests in watch mode
- `npx vitest run tests/primitives/dice.test.ts` — run a single test file

## Tech Stack

- **Runtime**: TypeScript on Node.js 18+
- **Agent Framework**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Custom Tools**: In-process MCP servers via `createSdkMcpServer()` + `tool()` helper
- **Frontend** (later): Light HTML/CSS player UI, terminal-first during development
- **Testing**: Vitest for project tests; auto-generated tests for TTRPG tools
- **Knowledge Base**: JSON files explored via glob/grep (not RAG/vector DB)

## Claude Agent SDK — Key Concepts

The Agent SDK is NOT the raw Claude API. It provides an agentic loop with built-in tools (Read, Write, Bash, Grep, Glob, etc.) and handles tool execution automatically.

**Core patterns used in this project:**

- **`query()`** — main entry point; streams messages from an agent running an agentic loop
- **Custom tools** — defined with `tool()`, bundled into MCP servers with `createSdkMcpServer()`, registered via `mcpServers` option. Tool names follow `mcp__{server}__{tool}` format.
- **Subagents** — spawned by the main agent for isolated, parallelizable subtasks. Each gets a fresh context window. Defined via `agents` option as `AgentDefinition` objects with their own tools, prompts, and model choices.
- **Sessions** — conversation history persists to disk automatically. Resume with `resume: sessionId`. Fork with `forkSession: true`.
- **Hooks** — lifecycle callbacks (PreToolUse, PostToolUse, etc.) for validation and logging.
- **Permissions** — `allowedTools` whitelist auto-approves tools; `permissionMode` controls approval flow (`acceptEdits`, `dontAsk`, `bypassPermissions`).
- **Error handling** — tools return `isError: true` for recoverable failures; uncaught exceptions terminate the loop.

## Architecture

The system has two major phases, both implemented as Claude Agent SDK agent configurations.

### Separation of duties

The guiding principle: **mechanics → tools, bookkeeping → specialist subagents, narrative → the facilitator agent.** Each layer owns its concern; the facilitator's attention is reserved for voice, pacing, and fiction.

- **Mechanics live in tools.** Primitives handle raw resolution; generated game tools classify outcomes into structured hints. The facilitator never does dice math.
- **Bookkeeping lives in Haiku subagents.** A bookkeeper subagent owns writes to the typed memory books (npcs / factions / character_sheets). The facilitator reads them for continuity but doesn't file entries itself — that filing discipline would compete with its narrative attention, and empirically loses. Future subagents (continuity-checker, lore-spelunker, session-recap-writer) follow the same pattern: fresh `query()` per invocation, Haiku model, scoped tool access, orchestrated by play.ts at turn boundaries or on demand.
- **Narrative lives in the facilitator.** It picks tools by fiction, reads hints, writes prose in the game's voice. Tone comes from the per-game facilitatorPrompt (written by the characterizer).

### Three-Layer Tool Model

1. **Primitives** — pure mechanical operations, hand-written TypeScript: `rollDice()`, `drawFromPool()`, `weightedPick()`, `rollOnTable()`, resource + clock ops. Clean, obvious API surface so generated code can call them reliably.
2. **Generated game tools** — bespoke MCP tools the tool-builder writes per game. Each wraps one or more primitives and encodes: narrative trigger condition, which primitive(s) to call, how to classify the result into the structured hint vocabulary (outcome_tier, pressure, salient_facts, suggested_beats), what structured flags to expose. Example: a PbtA-style move tool calls `rollDice("2d6")`, adds a stat modifier, classifies outcome tiers (6-/7-9/10+), emits hints — no prose.
3. **The facilitator agent** — operates at the fiction layer only. Picks tools by narrative context ("the player is intimidating someone → call the appropriate move"), sees only structured hint output, never raw dice math. Prose voice comes from the per-game facilitatorPrompt.

This scales across game types: dice games wrap the dice primitive, tension-mechanic games wrap a Jenga-or-similar primitive, diceless games wrap resource tracking, etc.

### Phase 1: Brigliadoro (Tool/Lore Creation)

- Reads TTRPG sourcebook PDFs or text input
- A **tool-builder subagent** generates game-specific tools (layer 2) as TypeScript MCP tool definitions that call the primitives (layer 1), plus a trigger-rate eval corpus per tool. Its system prompt is workflow-shaped (read sourcebook → inventory mechanics → classify one-shot vs pausable → write → review) with deep reference material in `src/meta/prompts/references/tool-reference.md` loaded on demand.
- Tools support **mid-resolution player input** via the pausable state-machine pattern (phase: "start"/"continue" + StepStore); no AskUserQuestion dependency. The pausable pattern is MANDATORY for any mechanic requiring mid-resolution player input — flags on one-shot tools silently get absorbed into narration.
- A **characterizer subagent** classifies the game's facilitator style (narrative-authority axis, scene-framing axis, facilitator-as-character axis, in-game role name), writes the per-game facilitatorPrompt, lore summary, and character/setup creation config
- A **validator subagent** auto-generates unit tests for created tools (including Gate 1 differential tests against the primitive oracle); tools must pass before handoff. Deep test patterns live in `src/meta/prompts/references/testing-reference.md`.

### Phase 2: Runner (Play Session)

A **runner** is a generated directory containing everything needed to play a specific game:

- Generated MCP tool files (the game's mechanics as tools)
- Trigger-rate eval corpus (`evals/*.triggers.json`)
- JSON knowledge base (`lore/summary.json`)
- `config.json` with facilitatorPrompt, character/setup creation
- State directory (`state/`) holding scratchpad + typed memory books (`npcs.json`, `factions.json`, `character-sheets.json`) + session-id pointer

Runners are shareable (e.g., push to GitHub) as long as the source material's licensing permits.

- **The facilitator agent** uses the generated MCP tools + memory books + knowledge base to run the game
- **The bookkeeper subagent** (Haiku) runs after each facilitator turn to scan for named entities and write them to the typed memory books. Facilitator reads the books for continuity but doesn't write to them itself.
- Player interaction via the terminal play harness (readline); skinned HTML/CSS UI later
- The facilitator sees only structured hint output from tools, not intermediate mechanical steps
- Session state (Agent SDK session history) + scratchpad + books are saveable; runner supports `--resume`/`--new`/`--new-session` and `/quit`/`/new`/`/new-session` runtime commands
- **Per-session observability**: markdown transcript at `state/transcripts/<shortid>.md` (player + facilitator text + tool calls + tool results) plus JSONL subagent trace at `state/transcripts/<shortid>.subagents.jsonl` (one line per subagent invocation with turn, input, tool calls, duration).

### Agent Topology

Current:

```
Brigliadoro Orchestrator (Sonnet by default; --models quality uses Opus for taste)
├── tool-builder subagent   — writes game tools (pure fn + thin MCP handler) + triggers.json eval corpus
├── characterizer subagent  — classifies game's facilitator style, writes facilitatorPrompt + lore + setup config
└── validator subagent      — writes differential + scenario tests, runs them, fixes failures
        │
        ▼ (generated runner directory)
Runner (orchestrated by play.ts)
├── Facilitator agent (Sonnet; plays the in-game role the characterizer picked — GM / Lens / Cardinal / etc.)
│   ├── Universal prompt: session/sitting lifecycle, memory discipline, hint decoding, pause handling
│   ├── Per-game prompt (from config.facilitatorPrompt): role, tone, world, turn structure, tool-usage prose
│   ├── Memory books (npcs, factions, character_sheets) — READ-only from the facilitator's side
│   ├── Scratchpad — facilitator owns writes here
│   └── Player interaction via terminal readline (skinnable UI later)
└── Bookkeeper subagent (Haiku; spawned after each facilitator turn)
    ├── Scoped to npcs / factions / character_sheets upsert ops (via allowedTools)
    ├── Reads turn text, upserts named-entity records
    └── Runs async during player thinking time; awaited before next turn / on /quit
```

Future subagents (continuity-checker, lore-spelunker, session-recap-writer, safety-monitor) follow the same pattern: fresh query, Haiku model, scoped MCP access, orchestrated at turn boundaries or on demand. Plan at `C:\Users\Cad\.claude\plans\bookkeeper-subagent.md`.

Model selection rationale: Opus for decisions requiring taste and narrative judgment, Sonnet for bulk code generation, Haiku for cheap repetitive parsing/validation. The Agent SDK supports per-subagent `model` selection.

## Key Design Decisions

- **Claude Agent SDK, not raw API** — the SDK handles the agentic loop, tool execution, session persistence, and subagent orchestration; we don't reimplement any of that
- **Custom tools as in-process MCP servers** — no network overhead, tools run in the same process as the agent
- **Separation of duties (mechanics / bookkeeping / narrative)** — see the Separation of Duties section above. Specialist subagents handle bookkeeping-style work so the facilitator's attention stays on voice and fiction
- **The facilitator operates at the fiction layer** — resolution primitives are straightforward ground-truth code; the facilitator reads structured hints and writes prose, never raw dice math
- **Tools emit structured hints, not prose** — `outcome_tier`, `pressure`, `salient_facts`, `suggested_beats` plus raw mechanical record. No `guidance`/`narration` prose fields. The per-game facilitatorPrompt (written by the characterizer) is the single source of narrative voice
- **Pausable pattern is MANDATORY for mid-resolution player input** — any mechanic whose correct resolution requires something from the player (a question, a choice, a declared fact) uses the state-machine + StepStore pattern. Flags on one-shot tools get absorbed into narration and the mechanic decomposes silently
- **"Facilitator" is the unified internal role** — classic GM, Lens, Cardinal, Host, etc. are per-game in-game role names. The characterizer picks one per game; the universal code uses "facilitator"
- **Knowledge base uses glob/grep, not RAG/vector DB** — per Anthropic's own recommendation that agent-driven file exploration outperforms vector search
- **Clocks are universal** — the facilitator should use clocks/progress meters regardless of whether the source TTRPG includes them
- **Broad genre support required** — must handle OSR, narrative, diceless, and GMless games. The facilitator framing + characterizer axis classification is what makes GMless support possible
- **Terminal-first development** — skinned UI is a later concern; initial testing stays in-terminal. Keep things modular so we can switch over easily
- **Open source / Creative Commons** — public-facing examples must use only open-source TTRPG material. Avoid proprietary game names in CLAUDE.md, README, commit messages, and prompt examples — PbtA as a framework is fine; specific proprietary titles aren't
- **Primitives must have a clean API surface** — the tool-builder generates TypeScript code that calls these; a simple, obvious API maximizes code generation success
- **Subagent prompts use progressive disclosure** — core workflow in the system prompt, deep reference material (signatures, templates, edge cases) in separate markdown files the subagent Reads on demand. Modelled on Anthropic's skill-creator SKILL.md pattern. Explaining *why* (theory-of-mind) generalises better than shouting `MUST` / `NEVER`

## Roadmap

- **GMless-game empirical validation** — generate a runner for a shared-authorship / no-GM game and confirm the facilitator framing holds in real play. This is the highest-priority next validation since the facilitator refactor was motivated by GMless support but hasn't been exercised on one yet.
- **Hard sourcebook stress test** — one-page RPGs are easy mode. The real test is a densely-laid-out rules-heavy game, or one with unconventional mechanics and lore intermixed in prose. This is the bar for "actually works"
- **Lore distillation** — succinct summary always in context + greppable deeper lore for lookups (currently only `lore/summary.json`)
- **Facilitator agent quality** — narrative theory, facilitation principles (PbtA-derived but role-neutral), smooth conversational style, session zero for player calibration + safety tools, trim verbosity
- **More specialist subagents** — continuity-checker, lore-spelunker, session-recap-writer (see the bookkeeper plan). One at a time, driven by observed gaps in play
- **Multi-model topology** — `--models quality` preset exists (Opus orchestrator + characterizer, Haiku validator) but hasn't been benchmarked
- **Player-facing UI** — skinnable HTML/CSS replacing the terminal readline

**Done** (noted because each was on this roadmap): typed memory books for NPCs/factions/character-sheets with file persistence; save/resume across restarts; structured hint vocabulary replacing prose guidance; facilitator framing for broad genre support; `outcome_tier` required on every tool return with a `"generated"` carve-out for pure content generators; forbidden prose fields (`full_description` etc.); shared hint types in `src/hints/`; pausable pattern MANDATORY for mid-resolution player input; bookkeeper subagent owns writes to typed books; tool-builder prompt restructured workflow-shaped with progressive-disclosure reference files.

## Runner Regeneration

Code changes to brigliadoro (primitives, prompts, play harness, generator contracts) often need regenerating existing runners to validate the full loop. Delete the old runner directory and re-run `npm run generate`. Regen is cheap — uses subscription rate limits, not paid API — and end-to-end regen catches things hand-patching misses. Default to regen for generator-contract changes. **Do warn** before regen if it would destroy in-progress play state (session-id, scratchpad notes, populated memory books) that the user would want to preserve — that's a data-loss concern, not a cost concern.

## Development rhythm

Commit per discrete feature, not per session. When a pick completes and tests go green, that's a commit-worthy moment. Bundling multiple features into one commit (as happened before a recent 3-way split rebase) creates a mess to untangle later. If multiple changes naturally accumulate, proactively surface "ready to commit?" at the natural breakpoint rather than continuing into the next task.

## Test Material

`test ttrpgs/` contains reference PDFs and links organized by complexity.
