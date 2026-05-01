# Runner runtime rules

Loads when working in `src/runner/` or runner-generated code.

## Regen is cheap, but data loss is not

Code changes to brigliadoro (primitives, prompts, play harness, generator contracts) often need regenerating existing runners to validate the full loop. Default to regen for generator-contract changes — end-to-end regen catches things hand-patching misses, and it uses subscription rate limits, not paid API.

**Warn before regen if it would destroy in-progress play state**: session-id, scratchpad notes, populated memory books. Regenerating moves the previous version to `runners/_archive/<name>-<timestamp>/` (which is gitignored), so generations are diffable and recoverable, but only if the user has been told what's about to happen.

## Testing infrastructure (composable hooks)

Five flags compose freely for non-interactive / deterministic play. All live in `src/runner/` and are independent of the generator.

- `--seed=N` (or `--rng-sequence=0.1,0.5,…`) — monkey-patches `Math.random` so dice are deterministic. Seed is logged in transcript header.
- `--player-script=FILE` — NDJSON, one message per line, returns `/quit` on EOF.
- `--player-script-tail=FILE` — polls NDJSON for new lines, blocks until one arrives, ends on `{"type":"quit"}` sentinel. Lets an external driver append turns live.
- `--player-preferences=FILE` — markdown with pre-baked session-zero answers. Facilitator skips the questions.
- `--split-agents` — opt-in Director/Narrator split runtime (Phase 1; monolith remains the default). See plan at `~/.claude/plans/brigliadoro-director-narrator-split.md`. Phase-1 simplifications: no `/resume`, no `/new`, no `/new-session`, no persistent session IDs.

Compose: `--seed=42 --player-script-tail=./turns.ndjson --player-preferences=./prefs.md` → fully deterministic, live-driven, preferences-pinned.

## Observability is per-session

- Markdown transcript: `state/transcripts/<shortid>.md` (player + facilitator text + tool calls + tool results).
- JSONL subagent trace: `state/transcripts/<shortid>.subagents.jsonl` (one line per subagent invocation: turn, input, tool calls, duration).

If a bug repro requires more visibility, extend these files rather than inventing a new logging channel.

## Pre-rendered opening message

Characterizer can write `config.openingMessage`, displayed directly to the player on first-time / `/new` modes before any LLM call. Saves an LLM call per first-time session and ensures consistent first impression. Falls back to agent-generated greeting when absent.

## Bookkeeper turn boundary

Bookkeeper subagent runs after each facilitator turn, async during player thinking time, awaited before next turn or on `/quit`. It receives a pre-supplied snapshot of current book state (`name → summary` per book) at each invocation so it match-or-creates against existing records rather than upserting variants of names that already exist.

Facilitator reads the books for continuity but **does not write to them**. That separation is load-bearing — empirically, bookkeeping discipline competes with narrative attention and loses.

## Director/Narrator split (opt-in)

When `--split-agents` is set, the monolithic facilitator is replaced by two cooperating agents:

- **Director** (`director.ts`) — reads state + player input, calls game and facilitator MCP tools, assembles a typed `NarratorBrief` (defined in `narrator-brief.ts`). Has tool access; does not write prose.
- **Narrator** (`narrator.ts`) — receives the brief, writes player-facing prose. Has zero tool access and no state visibility beyond the brief. Cannot author complications because by its turn the dice have already spoken.

Two parallel `query()` sessions per sitting (one each), two parallel sessionIds, both resumed per turn. The brief is the only channel from Director to Narrator — keep its schema lean; underspecified briefs leave Narrator filling gaps from imagination, overspecified briefs flatten the prose. Plan: `~/.claude/plans/brigliadoro-director-narrator-split.md`.

Persona shaping (Fan / Adversary / Referee / Author / Co-discoverer / Improv Partner) plugs in via `voice_hints.persona` in the brief. The persona library itself is a separate plan (`brigliadoro-persona-library.md`); v1 default is `"default"`.
