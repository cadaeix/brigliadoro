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

### Three-Layer Tool Model

This is the core architectural pattern:

1. **Primitives** — pure mechanical operations, hand-written TypeScript: `rollDice()`, `drawRandom()`, `trackResource()`, `advanceClock()`. Clean, obvious API surface so generated code can call them reliably.
2. **Generated game tools** — bespoke MCP tools that the Brigliadoro agent writes per game. Each wraps one or more primitives and encodes: narrative trigger condition, which primitive(s) to call, how to classify the result into a structured hint vocabulary (outcome_tier, pressure, salient_facts, suggested_beats), what structured flags to expose. Example: a PbtA "Lash Out" tool calls `rollDice("2d6")`, adds the stat modifier, classifies tiers (6-/7-9/10+), emits hints — no prose.
3. **The facilitator agent** — operates at the fiction layer only. Picks tools by narrative context ("the player is intimidating someone → call `lash_out`"), sees only the structured hint output, never raw dice math. Prose voice comes from the per-game facilitatorPrompt (written by the characterizer), not from tools.

This scales across game types: dice games wrap the dice primitive, Dread wraps a tension/Jenga primitive, diceless games wrap resource tracking, etc.

### Phase 1: Brigliadoro (Tool/Lore Creation)

- Reads TTRPG sourcebook PDFs or text input
- A **tool-builder subagent** generates game-specific tools (layer 2) as TypeScript MCP tool definitions that call the primitives (layer 1), plus a trigger-rate eval corpus per tool
- Tools support **mid-resolution player input** via the pausable state-machine pattern (phase: "start"/"continue" + StepStore); no AskUserQuestion dependency
- A **characterizer subagent** classifies the game's facilitator style (narrative-authority axis, scene-framing axis, facilitator-as-character axis, in-game role name), writes the per-game facilitatorPrompt, lore summary, and character/setup creation config
- A **validator subagent** auto-generates unit tests for created tools (including Gate 1 differential tests against the primitive oracle); tools must pass before handoff

### Phase 2: Runner (Play Session)

A **runner** is a generated directory containing everything needed to play a specific game:

- Generated MCP tool files (the game's mechanics as tools)
- Trigger-rate eval corpus (`evals/*.triggers.json`)
- JSON knowledge base (`lore/summary.json`)
- `config.json` with facilitatorPrompt, character/setup creation
- State directory (`state/`) holding scratchpad + typed memory books (`npcs.json`, `factions.json`, `character-sheets.json`) + session-id pointer

Runners are shareable (e.g., push to GitHub). Shorthand: "Honey Heist runner", "Ars Magica runner".

- **The facilitator agent** uses the generated MCP tools + memory books + knowledge base to run the game
- Player interaction via the terminal play harness (readline); skinned HTML/CSS UI later
- The facilitator sees only structured hint output from tools, not intermediate mechanical steps
- Session state (Agent SDK session history) + scratchpad + books are saveable; runner supports `--resume`/`--new`/`--new-session` and `/quit`/`/new`/`/new-session` runtime commands

### Agent Topology

Current:

```
Brigliadoro Orchestrator (Sonnet by default; --models quality uses Opus for taste)
├── tool-builder subagent   — writes game tools (pure fn + thin MCP handler) + triggers.json eval corpus
├── characterizer subagent  — classifies game's facilitator style, writes facilitatorPrompt + lore + setup config
└── validator subagent      — writes differential + scenario tests, runs them, fixes failures
        │
        ▼ (generated runner directory)
Runner
└── Facilitator agent (Sonnet; plays the in-game role the characterizer picked — GM / Lens / Cardinal / etc.)
    ├── Universal prompt: session/sitting lifecycle, memory discipline, hint decoding, pause handling
    ├── Per-game prompt (from config.facilitatorPrompt): role, tone, world, turn structure, tool-usage prose
    ├── Memory books (npcs, factions, character_sheets) + scratchpad
    └── Player interaction via terminal readline (skinnable UI later)
```

Model selection rationale: Opus for decisions requiring taste and narrative judgment, Sonnet for bulk code generation, Haiku for cheap repetitive parsing/validation. The Agent SDK supports per-subagent `model` selection.

## Key Design Decisions

- **Claude Agent SDK, not raw API** — the SDK handles the agentic loop, tool execution, session persistence, and subagent orchestration; we don't reimplement any of that
- **Custom tools as in-process MCP servers** — no network overhead, tools run in the same process as the agent
- **The facilitator operates at the fiction layer** — resolution primitives are straightforward ground-truth code; the facilitator reads structured hints and writes prose, never raw dice math
- **Tools emit structured hints, not prose** — `outcome_tier`, `pressure`, `salient_facts`, `suggested_beats` plus raw mechanical record. No `guidance`/`narration` prose fields. The per-game facilitatorPrompt (written by the characterizer) is the single source of narrative voice
- **"Facilitator" is the unified internal role** — classic GM, Lens, Cardinal, Host, etc. are per-game in-game role names. The characterizer picks one per game; the universal code uses "facilitator"
- **Knowledge base uses glob/grep, not RAG/vector DB** — per Anthropic's own recommendation that agent-driven file exploration outperforms vector search
- **Clocks are universal** — the facilitator should use clocks/progress meters regardless of whether the source TTRPG includes them
- **Broad genre support required** — must handle OSR, narrative, diceless, and GMless games. The facilitator framing + characterizer axis classification is what makes GMless support possible
- **Terminal-first development** — skinned UI is a later concern; initial testing stays in-terminal. Keep things modular so we can switch over easily
- **Open source / Creative Commons** — public-facing examples must use only open-source TTRPG material
- **Primitives must have a clean API surface** — the tool-builder generates TypeScript code that calls these; a simple, obvious API maximizes code generation success

## Roadmap (Post-MVP)

After mechanic adaptation works on simple games:

1. **Hard sourcebook stress test** — some TTRPGs are notorious for poor formatting, layout and information organisation
2. **Lore distillation** — succinct summary always in context + greppable deeper lore for lookups
3. **Persistent game state** — character sheets, NPCs, factions, world concepts
4. **Facilitator agent quality** — narrative theory, facilitation principles (PbtA-derived but role-neutral), smooth conversational style, session zero for player calibration + safety tools. GMless-game support validation (generate a runner for Microscope or Fiasco, confirm the facilitator framing holds)

## Runner Regeneration

Code changes to brigliadoro (primitives, Meta-TTRPGinator prompt, play harness, etc.) may require regenerating existing runners. Delete the old runner directory and re-run `npm run generate`. **Always ask the user before regenerating** — runner generation uses the Claude API and counts against subscription rate limits.

## Test Material

`test ttrpgs/` contains reference PDFs and links organized by complexity.
