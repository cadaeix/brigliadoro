/**
 * Library entry point for invoking the Narrator agent in the split-agent
 * runner. The Narrator receives a NarratorBrief from the Director and
 * writes the player-facing prose. No tool access; no state visibility
 * beyond the brief.
 *
 * Phase-1 scaffolding. See `~/.claude/plans/brigliadoro-director-narrator-
 * split.md` for the architectural rationale.
 *
 * The Narrator:
 * - Has NO MCP tools and NO built-in tools. Pure prose generation.
 * - Writes its prose to stdout (this is what the player sees) and to
 *   the transcript.
 * - Maintains its own session ID separate from the Director — its
 *   session memory carries voice continuity across turns.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NarratorBrief } from "./narrator-brief.js";
import type { TranscriptWriter } from "./transcript.js";
import type { AgentModel } from "./director.js";

export interface NarratorRunOptions {
  /** The brief from the Director. Serialized as JSON for the Narrator. */
  brief: NarratorBrief;
  /** System prompt — typically NARRATOR_PROMPT from prompts/narrator.ts. */
  systemPrompt: string;
  /** Resume an in-flight Narrator session — preserves voice continuity. */
  resumeSessionId?: string;
  /** Model — defaults to Sonnet (per the plan, Sonnet floor for Narrator). */
  model?: AgentModel;
  /**
   * Transcript writer. The Narrator's prose is written to the transcript
   * verbatim (it's the player-facing output). Tool calls are not
   * expected since the Narrator has no tool access.
   */
  transcript: TranscriptWriter;
}

export interface NarratorRunResult {
  prose: string;
  sessionId: string;
}

/**
 * Run one Narrator turn. The brief is serialized into the user-side
 * message; the Narrator's system prompt does the rest.
 *
 * Phase 1: serialize as a JSON code block within a structured wrapper
 * message. Easy for the Narrator to parse mentally; preserves voice
 * focus by not embedding the brief in the system prompt (which would
 * pollute persistent context across turns).
 */
export async function runNarrator(
  opts: NarratorRunOptions
): Promise<NarratorRunResult> {
  const {
    brief,
    systemPrompt,
    resumeSessionId,
    model = "sonnet",
    transcript,
  } = opts;

  const userMessage = buildNarratorPrompt(brief);

  let prose = "";
  let sessionId = "";

  const queryOptions = {
    systemPrompt,
    model,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    // No tools at all. The Narrator is pure prose. Built-ins disabled
    // (`tools: []`) and no MCP servers registered.
    tools: [] as string[],
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };

  for await (const message of query({
    prompt: userMessage,
    options: queryOptions,
  })) {
    if (!("type" in message)) continue;

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<Record<string, unknown>> };
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(block.text);
          transcript.recordFacilitatorChunk(block.text);
          prose += block.text;
        }
        // tool_use blocks shouldn't appear (no tools), but if they do
        // we silently ignore — the Narrator has nothing to call.
      }
    } else if (message.type === "result") {
      const result = message as { session_id?: string; subtype?: string };
      sessionId = result.session_id ?? "";
      if (result.subtype !== "success") {
        console.error(`\n[Narrator ended with: ${result.subtype}]`);
      }
    }
  }

  // Ensure terminal output ends with newline; flush transcript turn.
  if (!prose.endsWith("\n")) {
    process.stdout.write("\n");
  }
  transcript.endFacilitatorTurn(sessionId);

  return { prose, sessionId };
}

/**
 * Build the user-side message for the Narrator. The brief is serialized
 * as a JSON block within structured framing so the Narrator can parse
 * it mentally and write prose in response.
 *
 * The framing is intentionally terse — the system prompt carries the
 * heavy instruction, this message just delivers per-turn payload.
 */
function buildNarratorPrompt(brief: NarratorBrief): string {
  return `Here is the Director's brief for this turn. Write the player-facing prose per your system prompt.

\`\`\`json
${JSON.stringify(brief, null, 2)}
\`\`\`

Write the prose now. Plain text, no JSON, no markdown fences, no preamble.`;
}
