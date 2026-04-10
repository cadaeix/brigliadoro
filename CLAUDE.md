# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Brigliadoro** is a harness that uses Claude (or another LLM) to create tools and lore from TTRPG sourcebooks, then generates a **Bespoke TTRPG Runner** — a two-player game where an LLM acts as GM/facilitator and a human plays through a skinned text UI.

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
2. **Generated game tools** — bespoke MCP tools that the Brigliadoro agent writes per game. Each wraps one or more primitives and encodes: narrative trigger condition, which primitive(s) to call, how to interpret the result, what to return to GM Claude. Example: a PbtA "Lash Out" tool calls `rollDice("2d6")`, adds the stat modifier, interprets tiers (6-/7-9/10+), returns a narrative-ready result.
3. **GM Claude** — operates at the fiction layer only. Picks tools by narrative context ("the player is intimidating someone → call `lash_out`"), sees only the final interpreted result, never raw dice math.

This scales across game types: dice games wrap the dice primitive, Dread wraps a tension/Jenga primitive, diceless games wrap resource tracking, etc.

### Phase 1: Brigliadoro (Tool/Lore Creation)

- Reads TTRPG sourcebook PDFs or text input
- A **builder agent** generates game-specific tools (layer 2) as TypeScript MCP tool definitions that call the primitives (layer 1)
- Tools must support **interrupts** via `AskUserQuestion` for mid-resolution player interaction (e.g., hit/stand in a blackjack-based mechanic)
- A **lore extraction subagent** generates a knowledge base as JSON files searchable via glob/grep
- A **test generation subagent** auto-generates unit tests for created tools; tools must pass before handoff to GM Claude

### Phase 2: Runner (Play Session)

A **runner** is a generated directory containing everything needed to play a specific game:

- Generated MCP tool files (the game's mechanics as tools)
- JSON knowledge base (lore, rules reference)
- Agent configuration (system prompt, tool registrations)
- Session/character data (created during play)

Runners are shareable (e.g., push to GitHub). Shorthand: "Honey Heist runner", "Ars Magica runner".

- **GM Claude agent** uses the generated MCP tools + knowledge base to run the game
- Player interaction routed through `AskUserQuestion`; later via a skinned HTML/CSS UI
- GM Claude sees only final tool results, not intermediate mechanical steps
- Session state, character sheets are saveable and shareable via Agent SDK session management

### Agent Topology

Current (MVP):

```
Brigliadoro (single agent, Sonnet)
  → reads sourcebook, generates tools + tests + lore + config
        │
        ▼ (generated runner directory)
Runner
└── GM Claude (agent with generated MCP tools + knowledge base)
    └── Player interaction (AskUserQuestion → later HTML/CSS UI)
```

Future (multi-model):

```
Brigliadoro Orchestrator (Opus — judgment, taste, coordination)
├── Mechanic Analyzer (Sonnet — extract and design game tools)
├── Tool Builder (Sonnet — write tool code + tests)
├── Lore Distiller (Opus — decide what matters, write summaries)
├── Table/Data Parser (Haiku — cheap bulk extraction of tables, lists, stats)
└── Validator (Haiku — run tests, check compilation, lint)
        │
        ▼
Runner
└── GM Claude (Opus or Sonnet — narrative quality matters here)
```

Model selection rationale: Opus for decisions requiring taste and narrative judgment, Sonnet for bulk code generation, Haiku for cheap repetitive parsing/validation. The Agent SDK supports per-subagent `model` selection.

## Key Design Decisions

- **Claude Agent SDK, not raw API** — the SDK handles the agentic loop, tool execution, session persistence, and subagent orchestration; we don't reimplement any of that
- **Custom tools as in-process MCP servers** — no network overhead, tools run in the same process as the agent
- **GM Claude sees final results only** — resolution primitives are straightforward ground-truth code; GM operates at the fiction layer, not the mechanics layer
- **Knowledge base uses glob/grep, not RAG/vector DB** — per Anthropic's own recommendation that agent-driven file exploration outperforms vector search
- **Clocks are universal** — GM Claude should use clocks/progress meters regardless of whether the source TTRPG includes them
- **Broad genre support required** — must handle OSR, narrative, diceless, and GMless games (where "GM" becomes facilitator/fellow player)
- **Terminal-first development** — skinned UI is a later concern; initial testing stays in-terminal. Keep things modular so we can switch over easily.
- **Open source / Creative Commons** — public-facing examples must use only open-source TTRPG material
- **Primitives must have a clean API surface** — the Brigliadoro agent generates TypeScript code that calls these; a simple, obvious API maximizes code generation success

## Roadmap (Post-MVP)

After mechanic adaptation works on simple games:

1. **Hard sourcebook stress test** — some TTRPGs are notorious for poor formatting, layout and information organisation
2. **Lore distillation** — succinct summary always in context + greppable deeper lore for lookups
3. **Persistent game state** — character sheets, NPCs, factions, world concepts
4. **GM Claude quality** — narrative theory, GM principles, smooth conversational style, session zero for player calibration + safety tools

## Test Material

`test ttrpgs/` contains reference PDFs and links organized by complexity.
