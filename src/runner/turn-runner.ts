/**
 * Turn-runner strategy interface.
 *
 * `play.ts` owns the input loop, command dispatch (/quit, /new,
 * /new-session, blank input), and the bookkeeper plumbing. Per-turn
 * agent invocation — and the session-state plumbing it requires —
 * lives behind this interface, with separate implementations for the
 * two runtime topologies:
 *
 *   - Monolith (`monolith-turn-runner.ts`) — one `query()` per turn
 *     against the full game-specific facilitator system prompt, resume
 *     threaded across turns, sessionId mirrored to disk so /resume
 *     survives across `npm run play` invocations.
 *
 *   - Split, Phase 1 (`split-turn-runner.ts`) — Director + Narrator
 *     per turn, two parallel ephemeral sessionIds threaded across
 *     turns within a single sitting only. No cross-run persistence
 *     yet (deferred to Phase 4 of the brigliadoro-director-narrator-
 *     split plan); the Phase-1 runner advertises
 *     `supportsSessionCommands: false` so play.ts can block /new /
 *     /new-session at the input layer.
 *
 * Phase-4 cutover collapses to one runner: the Split implementation
 * gains cross-run sessionId persistence, the Monolith file gets
 * deleted, and the `supportsSessionCommands` branch in play.ts goes
 * away.
 */

export interface TurnInput {
  /** The full user-side prompt to send the agent. Already framed for
   *  first-turn / resume / fresh-session / regular-turn as the caller
   *  needs. The runner doesn't add framing — what it gets is what the
   *  agent sees. */
  userPrompt: string;
  /** The player's verbatim input for this turn, when it differs from
   *  `userPrompt` (e.g. first turn after the opening message:
   *  `userPrompt` carries framing, `playerInput` is the raw response).
   *  The Split runner threads this into the Director's brief; the
   *  Monolith runner ignores it. Defaults to `userPrompt` when omitted. */
  playerInput?: string;
  /** 1-indexed turn number within the sitting, threaded from play.ts's
   *  turn counter. Used by the Split runner to align director-trace
   *  entries with bookkeeper-trace entries (same turn number lands in
   *  both JSONL files). The Monolith runner ignores it — there's no
   *  director.jsonl for the monolith path. Optional for test ergonomics
   *  and back-compat; runners default to `0` when omitted. */
  turn?: number;
}

export interface TurnOutput {
  /** The prose the player saw this turn. Used as the bookkeeper's
   *  turnText input alongside the player's verbatim input. */
  facilitatorText: string;
  /** SessionId anchor for the bookkeeper's JSONL trace. For the Split
   *  runner this is the Director's id (the Narrator's id is internal).
   *  May be empty if the agent ended without a result message. */
  sessionIdForTrace: string;
}

export interface TurnRunner {
  /** Run one turn. Threads session-resume internally so callers don't
   *  see the SDK's resume contract. */
  runTurn(input: TurnInput): Promise<TurnOutput>;

  /** Forget any in-memory session state — the next `runTurn` starts a
   *  fresh Claude session (no resume). Called by play.ts after `/new`
   *  wipes state and after `/new-session` clears the session-id
   *  pointer. The Monolith runner also clears its disk-pointer; the
   *  Split runner's two ephemeral ids are wiped from memory. */
  resetSession(): void;

  /** Whether the runtime supports session-mode commands (/new,
   *  /new-session, /resume). False for the Phase-1 Split runner — per
   *  the plan, those are deferred to Phase 4. play.ts checks this
   *  before honouring those commands at the input layer. */
  readonly supportsSessionCommands: boolean;
}
