/**
 * Slash-command matcher used at every player-input prompt site.
 *
 * The invariant: anything the player types that starts with `/` is
 * interpreted as a meta-command and never reaches the LLM. Known
 * commands route to their handlers; unknown commands print a help
 * line and re-prompt. This stops two failure modes seen in real play:
 *
 * 1. **The `/new` leak** — a player typing `/new` at the opening
 *    prompt (defensive, wanting to ensure state was wiped) had `/new`
 *    passed to the LLM via `buildInitialPrompt` as their "first
 *    response," producing a meta-narrative "alright, let's start
 *    fresh" reply instead of a clean do-over. Intercepting all
 *    slash-prefixed input universally closes this class of bug.
 *
 * 2. **Typos slipping through** — `/quti` would currently be passed
 *    to the LLM as a turn ("the player said 'quti'"); the agent
 *    would do something with it rather than telling the player they
 *    typo'd the quit command. With universal interception, typos
 *    surface immediately at the harness layer.
 *
 * Centralised here so all prompt sites (main input loop, opening
 * prompt, future ones) share the same recognised-command set and the
 * same unknown-command UX.
 *
 * Not extended to `confirmPrompt` (the y/N prompt for "Saved session
 * found. Resume?" and the runtime /new wipe confirmation): those have
 * a binary semantic and recursively interpreting `/new` inside a "are
 * you sure?" prompt is more confusing than helpful. If a use case
 * emerges, revisit then.
 */

export type CommandKind = "quit" | "new" | "new-session" | "unknown";

export interface CommandMatch {
  /** Which command class matched. `unknown` covers any `/`-prefixed
   *  input that doesn't match one of the known names — the caller
   *  prints a help line and re-prompts. */
  kind: CommandKind;
  /** The verbatim trimmed input. For known commands this is just the
   *  command word; for `unknown` it carries whatever the player
   *  actually typed so the help line can echo it back. */
  raw: string;
}

/**
 * Classify a line of player input.
 *
 * Returns `null` for input that does NOT start with `/` — that's a
 * normal turn, send it to the LLM as usual. Returns a `CommandMatch`
 * for any `/`-prefixed input — the caller must handle it (route the
 * known commands, surface `unknown` to the player as a help line
 * rather than passing it to the LLM).
 *
 * Matching is case-insensitive on the command name (`/QUIT`, `/Quit`
 * and `/quit` all match). Leading / trailing whitespace is trimmed.
 */
export function matchCommand(input: string): CommandMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "/quit") return { kind: "quit", raw: trimmed };
  if (lower === "/new") return { kind: "new", raw: trimmed };
  if (lower === "/new-session") return { kind: "new-session", raw: trimmed };
  return { kind: "unknown", raw: trimmed };
}

/** Pretty help text listing the available commands. Used by the
 *  unknown-command surfaced at every prompt site so the player can
 *  recover from a typo without consulting docs. Single source of
 *  truth — every prompt site uses this so the listed set stays in
 *  sync with what `matchCommand` actually recognises. */
export const COMMAND_HELP =
  "Available commands: /quit, /new, /new-session";

/** Format the "unknown command" line shown to the player. Echoes
 *  what they typed plus the help list. */
export function unknownCommandMessage(raw: string): string {
  return `[Unknown command: ${raw}. ${COMMAND_HELP}.]`;
}
