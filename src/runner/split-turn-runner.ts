/**
 * Phase-1 Director/Narrator split runtime.
 *
 * Each turn: the Director plans + calls tools + emits a typed
 * `NarratorBrief`, then the Narrator writes prose from the brief. Both
 * run as separate `query()` sessions with their own ephemeral
 * sessionIds threaded across turns within a single sitting only.
 *
 * Cross-run persistence is deferred to Phase 4 of the
 * brigliadoro-director-narrator-split plan; this runner advertises
 * `supportsSessionCommands: false` so play.ts blocks /new /
 * /new-session at the input layer.
 *
 * Structurally absorbs the `runSplitTurn` closure that previously lived
 * inside `main()` in play.ts. The Director's system prompt is
 * pre-composed (DIRECTOR_PROMPT + game-specific framing + the game's
 * facilitator system prompt) at construction time so the per-turn path
 * is just two SDK calls + brief threading.
 */
import { type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  TurnInput,
  TurnOutput,
  TurnRunner,
} from "./turn-runner.js";
import type { TranscriptWriter } from "./transcript.js";
import { runDirector } from "./director.js";
import { runNarrator } from "./narrator.js";
import { DIRECTOR_PROMPT } from "./prompts/director.js";
import { NARRATOR_PROMPT } from "./prompts/narrator.js";
import {
  type DirectorTrace,
  type DirectorTraceEntry,
  TRUNCATE,
  truncateForTrace,
} from "./director-trace.js";

type SdkMcpServerInstance = ReturnType<typeof createSdkMcpServer>;

export interface SplitTurnRunnerOptions {
  /** The game-specific facilitator system prompt — appended to
   *  DIRECTOR_PROMPT with framing about who's in charge of voice vs
   *  planning. The Narrator uses NARRATOR_PROMPT alone (voice cues are
   *  carried per-turn in the brief, not in a persistent system prompt). */
  gameSystemPrompt: string;
  gameServer: SdkMcpServerInstance;
  facilitatorServer: SdkMcpServerInstance;
  transcript: TranscriptWriter;
  /** Per-session JSONL trace for Director input + raw text + parsed brief
   *  and Narrator brief + prose. Optional for testing ergonomics; in
   *  production play (via play.ts) this is always wired so prose-leak
   *  bugs like Q17 leave a debuggable artefact. The file is anchored on
   *  the Narrator's session id when known (so it pairs by short id with
   *  the markdown transcript), falling back to the Director's id on
   *  Director-failure turns where the Narrator never ran. */
  directorTrace?: DirectorTrace;
}

export function createSplitTurnRunner(
  opts: SplitTurnRunnerOptions
): TurnRunner {
  const {
    gameSystemPrompt,
    gameServer,
    facilitatorServer,
    transcript,
    directorTrace,
  } = opts;

  // Pre-compose the Director's system prompt once at construction. The
  // game-specific facilitator prompt carries voice cues, principles, and
  // tool-usage guidance — the Director treats those as authoritative for
  // brief.voice_hints / beat.intent population, not for prose voice
  // (that's the Narrator's surface).
  const directorSystemPrompt =
    DIRECTOR_PROMPT +
    `\n\n## Game-specific facilitator context\n\n` +
    `The system prompt below was authored for this specific game. It carries voice cues, principles, and tool-usage guidance you should treat as authoritative for game-specific framing. You — the Director — focus on the planning + brief side; the voice cues are most useful when populating brief.voice_hints and beat.intent.\n\n` +
    gameSystemPrompt;

  let directorSessionId: string | undefined;
  let narratorSessionId: string | undefined;

  return {
    supportsSessionCommands: false,

    resetSession(): void {
      directorSessionId = undefined;
      narratorSessionId = undefined;
    },

    async runTurn({
      userPrompt,
      playerInput,
      turn,
    }: TurnInput): Promise<TurnOutput> {
      const directorResult = await runDirector({
        prompt: userPrompt,
        systemPrompt: directorSystemPrompt,
        gameServer,
        facilitatorServer,
        resumeSessionId: directorSessionId,
        model: "sonnet",
        transcript,
      });

      // Pre-build the Director-half of the trace entry; the Narrator half
      // is filled in below if the brief parsed. Truncations + null-on-
      // failure shapes are intentional — the schema lives in
      // `director-trace.ts` and these match it exactly.
      const directorEntry: DirectorTraceEntry["director"] = {
        input: truncateForTrace(userPrompt, TRUNCATE.directorInput),
        sessionId: directorResult.sessionId ?? "",
        model: "sonnet",
        toolCalls: directorResult.diagnostics.toolCalls.map((c) => ({
          tool: c.tool,
          args: c.args,
          result:
            c.result !== undefined
              ? truncateForTrace(c.result, TRUNCATE.toolResult)
              : undefined,
        })),
        rawText: truncateForTrace(
          directorResult.diagnostics.rawText,
          TRUNCATE.directorRawText
        ),
        brief: directorResult.ok ? directorResult.brief : null,
        error: directorResult.ok ? null : directorResult.error,
        durationMs: directorResult.diagnostics.durationMs,
      };

      if (!directorResult.ok) {
        // Director returned a malformed brief. Phase-1 fallback: log
        // diagnostic, surface a degraded prose turn so the player sees
        // something rather than a silent hang. Stderr still gets the
        // short error + 400-char head for ops; the .md transcript and
        // .director.jsonl carry the full picture.
        console.error(
          `\n[Director failed: ${directorResult.error}]\n` +
            `[Raw text was: ${directorResult.rawText.slice(0, 400)}…]\n`
        );
        if (directorResult.sessionId) {
          directorSessionId = directorResult.sessionId;
        }

        // Surface the leaked prose inline in the .md transcript so you
        // can scroll the file and see what the Director said instead of
        // JSON. Truncated for storage hygiene (the JSONL has the same
        // text at the same budget).
        transcript.recordDirectorFailure(
          directorResult.error,
          truncateForTrace(
            directorResult.rawText,
            TRUNCATE.directorRawText
          )
        );

        const degraded =
          "(The Director returned a malformed brief. " +
          "This is a Phase-1 split-agents bug worth reporting; for now, " +
          "try rephrasing or use a fresh terminal without --split-agents.)";
        console.log("\n" + degraded + "\n");
        transcript.recordFacilitatorChunk(degraded + "\n");
        transcript.endFacilitatorTurn(directorResult.sessionId ?? "");

        // Anchor the trace file on the Director's session id when no
        // Narrator ran — the next successful turn will switch to the
        // Narrator anchor and pair with the .md filename.
        directorTrace?.append(directorResult.sessionId ?? "", {
          turn: turn ?? 0,
          director: directorEntry,
          narrator: null,
        });

        return {
          facilitatorText: degraded,
          sessionIdForTrace: directorResult.sessionId ?? "",
        };
      }

      directorSessionId = directorResult.sessionId;

      const narratorBrief = {
        ...directorResult.brief,
        // Always carry the player's verbatim input even if the Director
        // forgot to populate it. Falls back through playerInput →
        // userPrompt so first-turn cases (where userPrompt is framed
        // but playerInput is the raw response) are covered.
        player_input:
          directorResult.brief.player_input ||
          playerInput ||
          userPrompt,
      };

      const narratorResult = await runNarrator({
        brief: narratorBrief,
        systemPrompt: NARRATOR_PROMPT,
        resumeSessionId: narratorSessionId,
        model: "sonnet",
        transcript,
      });

      narratorSessionId = narratorResult.sessionId;

      // Anchor the trace file on the Narrator's session id so it pairs by
      // short id with the markdown transcript (which is keyed off the
      // first Narrator session id via endFacilitatorTurn). The brief
      // stored in directorEntry is the post-default-fill version — i.e.
      // exactly what the Narrator received.
      directorEntry.brief = narratorBrief;
      directorTrace?.append(
        narratorResult.sessionId || directorResult.sessionId,
        {
          turn: turn ?? 0,
          director: directorEntry,
          narrator: {
            sessionId: narratorResult.sessionId,
            model: "sonnet",
            prose: truncateForTrace(
              narratorResult.prose,
              TRUNCATE.narratorProse
            ),
            durationMs: narratorResult.durationMs,
          },
        }
      );

      return {
        facilitatorText: narratorResult.prose,
        // Director's id anchors the bookkeeper trace — Narrator's is
        // separate but the bookkeeper only needs one anchor.
        sessionIdForTrace: directorSessionId ?? "",
      };
    },
  };
}
