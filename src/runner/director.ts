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

export type DirectorRunResult =
  | {
      ok: true;
      brief: NarratorBrief;
      sessionId: string;
      rawJson: string;
    }
  | {
      ok: false;
      error: string;
      rawText: string;
      sessionId?: string;
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

  let streamedText = "";
  let finalResult = "";
  let sessionId = "";
  const toolUseNames = new Map<string, string>();

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

  for await (const message of query({
    prompt,
    options: queryOptions,
  })) {
    if (!("type" in message)) continue;

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<Record<string, unknown>> };
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          // Director text is the JSON brief — internal, not for stdout.
          streamedText += block.text;
        } else if (block.type === "tool_use") {
          const name = stripMcpPrefix(
            typeof block.name === "string" ? block.name : ""
          );
          const hint = summariseToolInput(block.input);
          const id = typeof block.id === "string" ? block.id : "";
          if (id) toolUseNames.set(id, name);
          // Log tool call to transcript (and to console as a dim line so
          // the operator can see mechanics firing during play).
          process.stdout.write(`\n\x1b[2m  [director] ↪ ${name}${hint}\x1b[0m\n`);
          transcript.recordToolCall(`director:${name}`, hint);
        }
      }
    } else if (message.type === "user" && "message" in message) {
      // Tool results arrive as tool_result blocks in user-role messages.
      const msg = message.message as { content: Array<Record<string, unknown>> };
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const id =
            typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const name = toolUseNames.get(id) ?? "unknown_tool";
          const resultText = extractToolResultText(block);
          transcript.recordToolResult(`director:${name}`, resultText);
        }
      }
    } else if (message.type === "result") {
      const result = message as {
        session_id?: string;
        subtype?: string;
        result?: string;
      };
      sessionId = result.session_id ?? "";
      finalResult = result.result ?? "";
      if (result.subtype !== "success") {
        console.error(`\n[Director ended with: ${result.subtype}]`);
      }
    }
  }

  // Prefer streamed assistant text; fall back to result-message synthesis.
  // Same dual-channel handling as the auditor harness — SDK can put the
  // final response in either place depending on how the model ended.
  const raw = streamedText.trim() || finalResult.trim();

  const json = extractJsonObject(raw);
  if (!json) {
    return {
      ok: false,
      error:
        "Director did not return a JSON object. " +
        `Streamed text: ${streamedText.length} chars; ` +
        `final result: ${finalResult.length} chars.`,
      rawText: raw,
      sessionId,
    };
  }

  const parsed = parseNarratorBrief(json);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawText: json,
      sessionId,
    };
  }

  return {
    ok: true,
    brief: parsed.brief,
    sessionId,
    rawJson: json,
  };
}

/**
 * Extract the first balanced JSON object from a possibly-noisy string.
 * Tolerates accidental ```json fences, leading prose, or trailing commentary.
 * Same implementation as the auditor harness — duplicated rather than
 * shared because the dependency would point runtime code at meta-side
 * code, which we keep separate.
 */
function extractJsonObject(text: string): string | null {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const start = stripped.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}

function stripMcpPrefix(name: string): string {
  // Tool names from MCP servers come prefixed (e.g. mcp__facilitator__npcs).
  // Strip for compactness in transcript / console.
  const m = name.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1]! : name;
}

function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length === 0) return "";
  // First non-trivial value, truncated.
  const first = keys[0]!;
  const v = (input as Record<string, unknown>)[first];
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const truncated = s.length > 30 ? s.slice(0, 30) + "…" : s;
  return ` ${first}=${JSON.stringify(truncated)}`;
}

function extractToolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        c &&
        typeof c === "object" &&
        (c as Record<string, unknown>).type === "text" &&
        typeof (c as Record<string, unknown>).text === "string"
      ) {
        return (c as Record<string, unknown>).text as string;
      }
    }
  } else if (typeof content === "string") {
    return content;
  }
  return "";
}
