/**
 * Library entry point for invoking the Director agent in the split-agent
 * runner. The Director plans + calls tools + emits a NarratorBrief; the
 * Narrator (separate file) writes the player-facing prose downstream.
 *
 * Phase-1 scaffolding: this is the runtime side of the brigliadoro-
 * director-narrator-split plan. See that plan file for the architectural
 * rationale, including why each agent has the tool access it does and
 * why the brief is a typed JSON contract rather than free-form prose.
 *
 * The Director:
 * - Has facilitator MCP tools (typed memory books, scratchpad) for
 *   continuity reads.
 * - Has the game's MCP server for resolution tools (risky_action,
 *   spend_thorns, random tables, etc.).
 * - Does NOT have built-in tools (Read/Write/Edit/Bash). Built-ins are
 *   structurally absent via `tools: []`, mirroring the orchestrator-side
 *   discipline shipped in commit 6847f4e.
 * - Does NOT write to stdout. Its JSON brief is internal — the Narrator's
 *   prose is what the player sees.
 *
 * Tool calls are logged to the transcript and to the subagent trace
 * (when wired) so we can audit what the Director decided across the
 * session.
 */

import { query, type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  parseNarratorBrief,
  type NarratorBrief,
} from "./narrator-brief.js";
import type { TranscriptWriter } from "./transcript.js";
import type { DirectorToolCall } from "./director-trace.js";
import {
  extractJsonObject,
  streamSdkQuery,
  summariseToolInput,
} from "./sdk-utils.js";

export type AgentModel = "sonnet" | "opus" | "haiku";

/**
 * The runtime instance type returned by `createSdkMcpServer`. The SDK
 * doesn't export this alias directly, so we derive it from the function's
 * return type. Used for the typed MCP-server params in the Director.
 */
type SdkMcpServerInstance = ReturnType<typeof createSdkMcpServer>;

export interface DirectorRunOptions {
  /** The user-side message for this turn. Player input + framing. */
  prompt: string;
  /** System prompt — typically DIRECTOR_PROMPT from prompts/director.ts. */
  systemPrompt: string;
  /** Game's MCP server (built by createGameServer in tools/server.ts). */
  gameServer: SdkMcpServerInstance;
  /** Facilitator's MCP server (typed books + scratchpad). */
  facilitatorServer: SdkMcpServerInstance;
  /** Resume an in-flight Director session — preserves prior brief history. */
  resumeSessionId?: string;
  /** Model — defaults to Sonnet (per the plan, Sonnet floor for Director). */
  model?: AgentModel;
  /**
   * Transcript writer. The Director's tool calls are mirrored to the
   * transcript so playback shows mechanical decisions alongside Narrator
   * prose. The Director's text output (the JSON brief) is NOT written to
   * stdout or transcript-as-prose — it's internal to the harness.
   */
  transcript: TranscriptWriter;
}

/** Diagnostic payload captured during a Director run, surfaced on both
 *  success and failure so the split-turn runner can write a director-trace
 *  entry without re-walking the stream. `rawText` is the model's streamed
 *  assistant text (the JSON brief on success, leaked prose on failure);
 *  `toolCalls` carries args + result for every MCP tool the Director
 *  invoked this turn. */
export interface DirectorDiagnostics {
  rawText: string;
  toolCalls: DirectorToolCall[];
  durationMs: number;
}

export type DirectorRunResult =
  | {
      ok: true;
      brief: NarratorBrief;
      sessionId: string;
      rawJson: string;
      diagnostics: DirectorDiagnostics;
    }
  | {
      ok: false;
      error: string;
      rawText: string;
      sessionId?: string;
      diagnostics: DirectorDiagnostics;
    };

/**
 * Run one Director turn. Streams the SDK query, captures tool calls
 * (mirrored to transcript), captures the final text response, parses it
 * as a NarratorBrief.
 *
 * On parse failure, returns `{ ok: false, error, rawText }`. Caller
 * decides whether to retry, log, or surface the diagnostic. Phase-1
 * harness logs and falls through to a degraded prose path.
 */
export async function runDirector(
  opts: DirectorRunOptions
): Promise<DirectorRunResult> {
  const {
    prompt,
    systemPrompt,
    gameServer,
    facilitatorServer,
    resumeSessionId,
    model = "sonnet",
    transcript,
  } = opts;

  const queryOptions = {
    systemPrompt,
    mcpServers: {
      [gameServer.name]: gameServer,
      facilitator: facilitatorServer,
    },
    model,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    // Built-ins disabled — Director gets only MCP tools (game + facilitator).
    // No Read/Write/Edit/Bash. This is structural enforcement of the
    // Director's "doesn't touch the filesystem directly" contract.
    tools: [] as string[],
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };

  // Capture tool calls + their results for the trace. Paired by SDK id
  // so a tool_result that arrives out-of-order with its tool_use still
  // lands on the right entry. tool_use blocks become entries
  // immediately; tool_result blocks slot in via the id index.
  const toolCalls: DirectorToolCall[] = [];
  const toolIndexById = new Map<string, number>();

  const startedAt = Date.now();
  const summary = await streamSdkQuery(
    query({ prompt, options: queryOptions }),
    {
      // Director text is the JSON brief — internal, not for stdout.
      // `streamSdkQuery` accumulates it into summary.text regardless.
      onToolUse({ name, input, id }) {
        const hint = summariseToolInput(input);
        // Log tool call to transcript and to console as a dim line so the
        // operator can see mechanics firing during play.
        process.stdout.write(
          `\n\x1b[2m  [director] ↪ ${name}${hint}\x1b[0m\n`
        );
        transcript.recordToolCall(`director:${name}`, hint);
        const idx = toolCalls.push({ tool: name, args: input }) - 1;
        if (id) toolIndexById.set(id, idx);
      },
      onToolResult({ name, text, id }) {
        transcript.recordToolResult(`director:${name}`, text);
        const idx = toolIndexById.get(id);
        if (idx !== undefined) {
          toolCalls[idx]!.result = text;
        } else {
          // Defensive: tool_result without a matching tool_use. Shouldn't
          // happen in practice (the SDK pairs them) but if it does we
          // record it as an orphan rather than dropping it on the floor.
          toolCalls.push({ tool: name, args: undefined, result: text });
        }
      },
      onResult({ subtype }) {
        if (subtype !== "success") {
          console.error(`\n[Director ended with: ${subtype}]`);
        }
      },
    }
  );
  const durationMs = Date.now() - startedAt;

  const sessionId = summary.sessionId;
  // Prefer streamed assistant text; fall back to result-message synthesis.
  // Same dual-channel handling as the auditor harness — SDK can put the
  // final response in either place depending on how the model ended.
  const raw = summary.text.trim() || summary.rawResult.trim();

  const diagnostics: DirectorDiagnostics = {
    rawText: raw,
    toolCalls,
    durationMs,
  };

  const json = extractJsonObject(raw);
  if (!json) {
    return {
      ok: false,
      error:
        "Director did not return a JSON object. " +
        `Streamed text: ${summary.text.length} chars; ` +
        `final result: ${summary.rawResult.length} chars.`,
      rawText: raw,
      sessionId,
      diagnostics,
    };
  }

  const parsed = parseNarratorBrief(json);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawText: json,
      sessionId,
      diagnostics,
    };
  }

  return {
    ok: true,
    brief: parsed.brief,
    sessionId,
    rawJson: json,
    diagnostics,
  };
}
