# Runner runtime rules

Loads when working in `src/runner/` or runner-generated code.

## Regen is cheap, but data loss is not

Code changes to brigliadoro (primitives, prompts, play harness, generator contracts) often need regenerating existing runners to validate the full loop. Default to regen for generator-contract changes — end-to-end regen catches things hand-patching misses, and it uses subscription rate limits, not paid API.

**Warn before regen if it would destroy in-progress play state**: session-id, scratchpad notes, populated memory books. Regenerating moves the previous version to `runners/_archive/<name>-<timestamp>/` (which is gitignored), so generations are diffable and recoverable, but only if the user has been told what's about to happen.

## Testing infrastructure (composable hooks)

Four flags compose freely for non-interactive / deterministic play. All live in `src/runner/` and are independent of the generator.

- `--seed=N` (or `--rng-sequence=0.1,0.5,…`) — monkey-patches `Math.random` so dice are deterministic. Seed is logged in transcript header.
- `--player-script=FILE` — NDJSON, one message per line, returns `/quit` on EOF.
- `--player-script-tail=FILE` — polls NDJSON for new lines, blocks until one arrives, ends on `{"type":"quit"}` sentinel. Lets an external driver append turns live.
- `--player-preferences=FILE` — markdown with pre-baked session-zero answers. Facilitator skips the questions.

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
