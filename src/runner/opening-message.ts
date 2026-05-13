/**
 * Opening-message capture + first-turn prompt construction.
 *
 * Two related concerns share this module because they're always used
 * together:
 *
 *   1. `presentOpeningMessage` shows the pre-rendered opening (when
 *      configured) and captures the player's first response. Used at
 *      session start in initial mode and on `/new` — the agent's first
 *      turn picks up from "the player saw the opening and responded
 *      with X" rather than greeting from scratch. This both saves an
 *      LLM call and ensures a consistent first impression in the
 *      characterizer-set voice.
 *
 *   2. `buildInitialPrompt` builds the user-side message that frames
 *      the agent's first turn. Threads in the captured first response
 *      (if any) plus any pre-baked session-zero preferences from
 *      `--player-preferences`.
 *
 * Both are framing concerns — `streamTurn` / `runDirector` / `runNarrator`
 * don't know or care that the first turn is special.
 */
import type { PlayerInputSource } from "./player-input.js";
import type { TranscriptWriter } from "./transcript.js";
import { matchCommand, unknownCommandMessage } from "./commands.js";

export type OpeningMessageOutcome =
  | { kind: "no-opening" }
  | { kind: "quit" }
  | { kind: "new-command" }
  | { kind: "new-session-command" }
  | { kind: "responded"; text: string };

export interface PresentOpeningMessageOptions {
  /** The pre-rendered opening from `config.openingMessage`, or undefined
   *  for older runners that don't carry one. */
  openingMessage: string | undefined;
  playerSource: PlayerInputSource;
  transcript: TranscriptWriter;
}

/**
 * Show the opening message (if configured) and capture the player's
 * first response. Returns one of:
 *
 *   - `no-opening` — no opening was configured. Caller should run its
 *     greet-from-scratch flow without threading a first response.
 *   - `quit` — player typed `/quit` before responding. Caller is
 *     responsible for any cleanup (await pending bookkeeper, close
 *     player source, etc.) and for printing the closing banner.
 *   - `new-command` — player typed `/new` at the opening prompt. The
 *     caller should wipe state and re-show the opening (a do-over
 *     before the player has committed any turns).
 *   - `new-session-command` — player typed `/new-session` at the
 *     opening prompt. At this point there's no session to drop yet,
 *     so semantically it's "drop the (nonexistent) session, keep the
 *     (empty) world" — effectively just re-show the opening without
 *     wiping. Caller distinguishes it from `new-command` for the
 *     status-line wording, but the structural action (loop back to
 *     re-show opening) is the same.
 *   - `responded` — player gave a non-command response. Caller threads
 *     `text` into `buildInitialPrompt` so the agent picks up from there.
 *
 * Unknown `/`-prefixed input (`/quti`, `/help`, `/sav3`) is handled
 * INTERNALLY in a loop: print an unknown-command help line and
 * re-prompt at this same opening, without ever returning to the
 * caller. This keeps the caller's switch small (only the meaningful
 * outcomes) and means typos never leak through to the LLM as
 * "the player's first response was /quti."
 *
 * The opening line is mirrored to the transcript as a facilitator
 * chunk on every iteration of the loop; the player's response (when
 * any) is mirrored as a player input. Command outcomes (/quit, /new,
 * /new-session, unknown) are NOT mirrored as player inputs — they're
 * user-side meta-actions, not turns the agent sees.
 */
export async function presentOpeningMessage(
  opts: PresentOpeningMessageOptions
): Promise<OpeningMessageOutcome> {
  const { openingMessage, playerSource, transcript } = opts;
  if (!openingMessage) return { kind: "no-opening" };

  // Loop so unknown commands re-prompt without re-rendering the
  // opening (the player already saw it; the re-prompt is just `> `).
  // First iteration shows the opening; subsequent iterations only
  // print the unknown-command line and the prompt.
  let firstIteration = true;
  while (true) {
    if (firstIteration) {
      console.log(`\n${openingMessage}\n`);
      transcript.recordFacilitatorChunk(openingMessage + "\n");
      firstIteration = false;
    }
    transcript.emitAwaitingMarker();
    const userInput = await playerSource.prompt("\n> ");
    const cmd = matchCommand(userInput);

    if (cmd === null) {
      // Normal non-slash input — record + return as the first
      // response. Use the trimmed text so trailing newlines from the
      // input source don't leak into buildInitialPrompt.
      const trimmed = userInput.trim();
      transcript.recordPlayerInput(trimmed);
      return { kind: "responded", text: trimmed };
    }

    switch (cmd.kind) {
      case "quit":
        return { kind: "quit" };
      case "new":
        return { kind: "new-command" };
      case "new-session":
        return { kind: "new-session-command" };
      case "unknown":
        // Print help to stdout only — don't pollute the transcript
        // with operator-facing harness chatter. Loop back to the
        // prompt without re-rendering the opening (already shown).
        console.log(unknownCommandMessage(cmd.raw));
        break;
    }
  }
}

export interface BuildInitialPromptOptions {
  gameName: string;
  /** The pre-rendered opening, when one was shown to the player. */
  openingMessage: string | undefined;
  /** The player's first response captured by `presentOpeningMessage`.
   *  Undefined when no opening was shown (or no response was needed). */
  playerFirstResponse: string | undefined;
  /** Pre-baked session-zero answers from `--player-preferences`, if any. */
  playerPreferencesText: string | undefined;
}

/**
 * Build the first-turn user-side prompt for the agent. When an opening
 * was shown and a response was captured, the prompt frames as
 * "they've already seen the opening and responded with X — continue from
 * there." Otherwise it frames as a fresh greeting.
 *
 * Player preferences (when supplied) are appended as a structured section
 * so the facilitator can skip the universal session-zero questions
 * already covered.
 */
export function buildInitialPrompt(opts: BuildInitialPromptOptions): string {
  const {
    gameName,
    openingMessage,
    playerFirstResponse,
    playerPreferencesText,
  } = opts;
  const sections: string[] = [];

  sections.push(`The player has just started a new game of ${gameName}.`);

  if (openingMessage && playerFirstResponse !== undefined) {
    sections.push(
      `They have already seen your opening message:\n\n"""\n${openingMessage}\n"""`
    );
    sections.push(
      `Their first response was:\n\n"""\n${playerFirstResponse}\n"""`
    );
    sections.push(
      `Continue from here. Don't repeat the opening message — they've read it. Begin the session zero flow / character creation as your instructions describe, picking up on what they said.`
    );
  } else {
    sections.push(
      `Greet them and begin the session zero flow as described in your instructions.`
    );
  }

  if (playerPreferencesText) {
    sections.push(
      `## Player preferences (supplied in advance)\n\nThe player has provided these answers ahead of time. Treat them as already-answered for the tone / safety / story-shape questions you'd otherwise ask during session zero. Do not re-ask what's covered here. If something important isn't covered, you can still ask about that.\n\n${playerPreferencesText}`
    );
  }

  return sections.join("\n\n");
}
