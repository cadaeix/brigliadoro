/**
 * Shared SDK streaming utilities for the runner side.
 *
 * The Director, Narrator, monolith facilitator, and bookkeeper all consume
 * the same SDK message shape from `query()`. This module factors out the
 * message-iteration skeleton (assistant text, tool_use, tool_result, result
 * blocks) so each caller only has to supply the per-event behaviour they
 * want — mirror to stdout? capture as JSON? record to transcript with what
 * prefix? — rather than re-walking the message structure every time.
 *
 * Lives in `src/runner/` specifically: runners ship as self-contained
 * directories, so code here is copied into every generated runner's
 * `lib/runner/` folder. Meta-side code (the auditor, the orchestrator)
 * keeps its own duplicate of any helper that overlaps — the runner ↔ meta
 * boundary is load-bearing, since runners are meant to be playable without
 * brigliadoro source on disk.
 */
export interface ToolUseEvent {
  /** Tool name with the `mcp__<server>__` prefix stripped. */
  name: string;
  /** Tool name as the SDK reported it, before stripping. */
  rawName: string;
  /** The arguments object the model passed. */
  input: unknown;
  /** SDK-assigned id; pairs with the matching tool_result. */
  id: string;
}

export interface ToolResultEvent {
  /** Tool name (stripped) corresponding to the matching tool_use. */
  name: string;
  /** The text payload extracted from the tool_result block. */
  text: string;
  /** SDK-assigned id matching the tool_use. */
  id: string;
}

export interface ResultEvent {
  sessionId: string;
  /** SDK result subtype — "success" on success, error class otherwise. */
  subtype?: string;
  /** SDK `result.result` field — the agent's final response if it ended
   *  cleanly. May be empty even on success if the agent only streamed
   *  assistant text and didn't produce a result-message body. */
  rawResult: string;
}

export interface StreamSdkHandlers {
  /** Called for each assistant text block, in order. */
  onText?: (text: string) => void;
  /** Called for each assistant tool_use block. */
  onToolUse?: (event: ToolUseEvent) => void;
  /** Called for each tool_result block (in user-role messages). The tool
   *  name is resolved from the matching tool_use's id; resolves to
   *  "unknown_tool" when no prior tool_use id matches (which would
   *  indicate a misshapen SDK message stream rather than a real bug). */
  onToolResult?: (event: ToolResultEvent) => void;
  /** Called once when the SDK emits a result message (end of turn). */
  onResult?: (event: ResultEvent) => void;
}

export interface StreamSdkSummary {
  sessionId: string;
  /** All assistant text blocks concatenated, in arrival order. */
  text: string;
  /** SDK result subtype from the final result message; "" if no result
   *  message arrived (which would be unusual). */
  subtype: string;
  /** SDK `result.result` field; "" if absent. */
  rawResult: string;
}

/**
 * Walk an SDK query async-iterable, dispatching to per-event handlers and
 * returning a summary at the end.
 *
 * The handlers control side effects (stdout mirroring, transcript writes,
 * accumulators on the caller's side); this function only walks the message
 * shapes and resolves tool_use ↔ tool_result pairs by id. Assistant text
 * blocks are accumulated into the returned `summary.text` regardless of
 * whether `onText` is provided, so callers that need the full text can
 * skip the handler.
 */
export async function streamSdkQuery(
  iter: AsyncIterable<Record<string, unknown>>,
  handlers: StreamSdkHandlers = {}
): Promise<StreamSdkSummary> {
  let sessionId = "";
  let text = "";
  let subtype = "";
  let rawResult = "";
  const toolUseNames = new Map<string, string>();

  for await (const message of iter) {
    if (!message || typeof message !== "object" || !("type" in message)) {
      continue;
    }

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content?: Array<Record<string, unknown>> };
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
          handlers.onText?.(block.text);
        } else if (block.type === "tool_use") {
          const rawName = typeof block.name === "string" ? block.name : "";
          const name = stripMcpPrefix(rawName);
          const id = typeof block.id === "string" ? block.id : "";
          if (id) toolUseNames.set(id, name);
          handlers.onToolUse?.({ name, rawName, input: block.input, id });
        }
      }
    } else if (message.type === "user" && "message" in message) {
      const msg = message.message as { content?: Array<Record<string, unknown>> };
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const id =
            typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const name = toolUseNames.get(id) ?? "unknown_tool";
          const resultText = extractToolResultText(block);
          handlers.onToolResult?.({ name, text: resultText, id });
        }
      }
    } else if (message.type === "result") {
      const result = message as {
        session_id?: string;
        subtype?: string;
        result?: string;
      };
      sessionId = result.session_id ?? "";
      subtype = result.subtype ?? "";
      rawResult = result.result ?? "";
      handlers.onResult?.({
        sessionId,
        subtype: result.subtype,
        rawResult,
      });
    }
  }

  return { sessionId, text, subtype, rawResult };
}

/**
 * Strip the MCP wrapper prefix `mcp__<server>__` from a tool name so
 * callers see e.g. "resolve_action" not "mcp__my-game__resolve_action".
 * Names without the prefix pass through unchanged.
 */
export function stripMcpPrefix(rawName: string): string {
  const parts = rawName.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return rawName;
}

/**
 * Extract the text payload from a tool_result block. MCP tool_results can
 * carry their content as an array of content blocks (typical) or a raw
 * string. Returns "" if neither shape yields any text.
 */
export function extractToolResultText(block: Record<string, unknown>): string {
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

/**
 * Build a short hint for a tool-call indicator line. Picks the most
 * identifying field from common tool-arg shapes and truncates. Falls back
 * to `phase` / `action` (pausable tools) and `kind` / `type` (discriminated
 * unions) so indicator lines stay informative for control-flow-heavy tools.
 *
 * When multiple informative fields are present (e.g. a pausable tool call
 * with both `phase: "continue"` and `action: "hit"`), shows both separated
 * by a bullet. Returns "" if nothing short and human-readable can be
 * extracted — caller should suppress the trailing space.
 *
 * The leading space in the return value is intentional: callers concatenate
 * directly after the tool name, e.g. `↪ ${name}${hint}`.
 */
export function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pickStr = (k: string): string | null => {
    const v = i[k];
    return typeof v === "string" && v ? v : null;
  };
  // "Primary" fields that identify WHAT entity/action the tool is working on.
  const primary =
    pickStr("name") ??
    pickStr("description") ??
    pickStr("threat") ??
    pickStr("operation") ??
    null;
  // "Control" fields that identify HOW the tool call is operating. Shown
  // alongside primary when both are present (e.g. memory-book upserts +
  // name), or on their own for pausable / discriminated-union tools.
  const control =
    pickStr("phase") ??
    pickStr("action") ??
    pickStr("kind") ??
    pickStr("type") ??
    null;

  const parts: string[] = [];
  if (primary) parts.push(primary);
  if (control) parts.push(control);
  if (parts.length === 0) return "";

  const max = 60;
  const joined = parts.join(" · ");
  const truncated = joined.length > max ? joined.slice(0, max) + "…" : joined;
  return ` ${JSON.stringify(truncated)}`;
}

/**
 * Extract the first balanced JSON object from a possibly-noisy string.
 * Tolerates accidental ```json fences, leading prose, or trailing
 * commentary. Returns the JSON substring on success, `null` if no
 * balanced object can be found.
 *
 * Used by the Director to parse the NarratorBrief out of the model's
 * response. The meta-side auditor harness has its own copy of this same
 * implementation — the runner ↔ meta boundary is intentional, since
 * runners ship as self-contained directories without meta-side code.
 */
export function extractJsonObject(text: string): string | null {
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
