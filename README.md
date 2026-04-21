# Brigliadoro - Bespoke TTRPG LLM Facilitator Generator

> Named after a mythical horse with a golden harness.

> [!IMPORTANT]
> This project is a **work in progress**. The core architecture is in place and the system can generate working runners from simple one-page RPGs, but there is a lot left to build. Expect breaking changes.

## What is this?

**Brigliadoro** is an agentic AI system that reads a TTRPG sourcebook (PDF or text) and generates a self-contained package of game-specific tools, lore, and configuration that lets a Claude agent facilitate a game alongside a human player. This self-contained package is called a **runner**. Depending on the game, the facilitator plays the role of a classic GM, a GMless peer, or whatever role the source material defines — the generator classifies the game's facilitation style and writes the runner accordingly.

## Why?

This isn't intended to replace human GMs, first of all. This is more of a playful exploration into the capabilities of LLMs to understand and utilise tabletop mechanics and narrative without being married to any particular system, as well as treating an LLM (Claude primarily) as a fellow player and participant in a game.

The idea came from seeing [Ars-Magica-Open-License](https://github.com/OriginalMadman/Ars-Magica-Open-License/), an open licensed game rendered in Markdown, and wondering how well Claude would do with comprehending it automatically.

The idea is that the LLM acting as a facilitator (GM, Lens, Cardinal, or fellow player depending on the game) can use tools that encode reusable mechanics and game maths without needing to rederive game rules. These tools serve multiple purposes: consistent mechanical representations, ground truth for the LLM and the player to riff off, and shaping the narrative the LLM understands the game world through.

Brigliadoro is the meta-framework to create these tools. Brigliadoro generates MCP tools that encode the game's mechanics as callable functions, to be triggered by narrative or procedure.

The facilitator agent picks tools by fiction ("the player is trying to hack the terminal" → call the appropriate move tool), and the tool handles all the mechanical resolution internally, returning a structured hint the facilitator turns into prose in the game's voice.

Brigliadoro also generates tests for the generated tools and automatically runs them, so that the tools can be refined.

In the future, Brigliadoro will be opinionated, as guided by personal design guidelines, in regards to TTRPG facilitation practices, narrative formation and writing styles. This may potentially be customisable. Brigliadoro also is intended to support non-traditional resolution mechanics, though we may have to draw a line at Jenga.

### That's a lot of acronyms!

**TTRPG:** Tabletop roleplaying games, involving participating in a collaborative fictional game setting by taking on roles, usually characters in a fictional setting. TTRPGs can be narrative, procedural, improv-focused, simulationist, goal driven, freeform, etc.
**LLM:** Large Language Model, like Claude
**Facilitator:** Brigliadoro's umbrella term for the persistent role an agent plays in any TTRPG — holding the procedure, tracking state, framing scenes, adjudicating mechanics. In classic games the facilitator is the **GM** (Game Master), with full narrative authority over the world and NPCs. In GMless games (Microscope, Fiasco, Belonging Outside Belonging) the facilitator is a shared or rotating role with less authority. Brigliadoro picks the right framing per game.
**GM:** Game Master — the classic facilitator role in traditional TTRPGs, directing goals, narrative, non-player characters, enemies, and other elements.
**MCP:** Model Context Protocol, or allowing an LLM to use external tools and systems.

## Current status

- [x] Foundation primitives (dice, randomness, resources, clocks) with full test coverage
- [x] MCP tool wrappers via Claude Agent SDK
- [x] Meta-TTRPGinator agent that reads sourcebooks and generates runners
- [x] Successfully generated a working single page RPG runner (3 game tools, 39 tests, lore, facilitator config)
- [x] Structured tool-output vocabulary (outcome_tier, pressure, salient_facts, suggested_beats) instead of prose
- [x] Typed memory books (npcs, factions, character_sheets) + freeform scratchpad with file persistence
- [x] Facilitator framing that generalizes across GM and GMless games
- [ ] Lore distillation (summaries + greppable deep lore)
- [ ] Facilitator quality layer (narrative principles, session zero, safety tools)
- [ ] Validated GMless-game runner (generate for Microscope or Fiasco)
- [ ] Player-facing UI... with aesthetic skins for different games
- [ ] Stress testing on complex/poorly-formatted sourcebooks
- [ ] Allowing for other LLM agents in both generation and facilitator roles

## Getting started

```bash
npm install
npm run build
npm test
```

To generate a runner from a sourcebook:

```bash
npm run generate -- "path/to/sourcebook.pdf" runner-name
```

This creates a `runners/<runner-name>/` directory with generated tools, tests, lore, and configuration.

### Architecture

1. **Primitives** — hand-written, game-agnostic mechanical building blocks (dice rolling, randomness, resource tracking, progress clocks)
2. **Generated game tools** — bespoke MCP tools that Brigliadoro writes per game, wrapping primitives. Each tool is a pure function + thin MCP handler, emits structured hints (not prose), and ships with a trigger-rate eval corpus
3. **Facilitator agent** — operates at the fiction layer only, using the generated tools. Its in-game role (GM, Lens, Cardinal, etc.) is chosen per-game by the characterizer

## A note on generated runners

Brigliadoro's source code is licensed under the [MIT License](LICENSE).

Generated runners contain rules, mechanics, lore, and other material derived from third-party TTRPG sourcebooks. That content remains subject to the original publisher's copyright and licensing terms.

Be mindful when sharing or publishing runners. If the source material is under an open license (CC BY, OGL, etc.), the runner can be shared under those terms. If the source material is proprietary, the runner is for personal use only.

Brigliadoro's MIT license is only applicable to Brigliadoro, and does not grant any rights to third-party content.

## Tech stack

- TypeScript on Node.js 18+
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for agent orchestration and MCP tools
- Vitest for testing

## License

MIT — see [LICENSE](LICENSE).
