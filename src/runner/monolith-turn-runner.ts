/**
 * Monolithic facilitator runtime.
 *
 * One `query()` per turn against the full game-specific system prompt,
 * resume threaded across turns, sessionId mirrored to disk every turn
 * so `/resume` works across `npm run play` invocations.
 *
 * Structurally absorbs the `streamTurn` helper that previously lived in
 * play.ts — same per-turn logic (mirror assistant text + tool-call
 * indicators to stdout, mirror everything to transcript), now packaged
 * with the session-state plumbing that previously was hand-threaded
 * through main().
 */
import { query, type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  TurnInput,
  TurnOutput,
  TurnRunner,
} from "./turn-runner.js";
import type { TranscriptWriter } from "./transcript.js";
import { streamSdkQuery, summariseToolInput } from "./sdk-utils.js";
import { writeSessionId } from "./session-mode.js";

type SdkMcpServerInstance = ReturnType<typeof createSdkMcpServer>;

export interface MonolithSharedOptions {
  systemPrompt: string;
  mcpServers: Record<string, SdkMcpServerInstance>;
  model: string;
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: boolean;
  tools: string[];
}

export interface MonolithTurnRunnerOptions {
  /** Base options for `query()`, shared across all turns. The runner
   *  spreads `resume:` on top of this when continuing a session. */
  sharedOptions: MonolithSharedOptions;
  /** State directory for persisting the session-id pointer
   *  (`session-id.txt`). Mirrored every turn after a successful
   *  agent reply. */
  stateDir: string;
  /** Initial session id from session-mode resolution. When set, the
   *  first turn resumes this session; otherwise the first turn starts
   *  a fresh Claude session. */
  initialSessionId: string | undefined;
  transcript: TranscriptWriter;
}

export function createMonolithTurnRunner(
  opts: MonolithTurnRunnerOptions
): TurnRunner {
  const { sharedOptions, stateDir, transcript } = opts;
  let currentSessionId: string | undefined = opts.initialSessionId;

  return {
    supportsSessionCommands: true,

    resetSession(): void {
      currentSessionId = undefined;
    },

    async runTurn({ userPrompt }: TurnInput): Promise<TurnOutput> {
      const queryOptions = currentSessionId
        ? { ...sharedOptions, resume: currentSessionId }
        : sharedOptions;

      const summary = await streamSdkQuery(
        query({ prompt: userPrompt, options: queryOptions }),
        {
          onText(text) {
            process.stdout.write(text);
            transcript.recordFacilitatorChunk(text);
          },
          onToolUse({ name, input }) {
            // Dim line showing the tool call so the player (and you,
            // debugging) can see the memory books and game tools firing
            // under the narration.
            const hint = summariseToolInput(input);
            process.stdout.write(`\n\x1b[2m  ↪ ${name}${hint}\x1b[0m\n`);
            transcript.recordToolCall(name, hint);
          },
          onToolResult({ name, text }) {
            // Don't print to stdout (would spam the game view); mirror
            // to transcript.
            transcript.recordToolResult(name, text);
          },
          onResult({ subtype }) {
            if (subtype !== "success") {
              console.error(`\n[Facilitator agent ended with: ${subtype}]`);
            }
          },
        }
      );

      // Ensure terminal output ends with newline; flush transcript turn.
      process.stdout.write("\n");
      transcript.endFacilitatorTurn(summary.sessionId);

      currentSessionId = summary.sessionId;
      writeSessionId(stateDir, summary.sessionId);

      return {
        facilitatorText: summary.text,
        sessionIdForTrace: summary.sessionId,
      };
    },
  };
}
