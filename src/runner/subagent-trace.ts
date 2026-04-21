/**
 * Per-session JSONL trace log for Haiku subagents (bookkeeper, future
 * continuity-checker, session-recap-writer, etc.).
 *
 * Each subagent invocation appends ONE line to
 * `state/transcripts/<shortid>.subagents.jsonl`. Append-only means crash-safe:
 * a partial write can only corrupt the line being written, never prior
 * records. Grep-friendly; trivial to join with the markdown transcript by
 * turn number.
 *
 * Rationale: with asynchronous specialist subagents mutating state, debugging
 * "why does the facilitator think X?" requires reconstructing which subagent
 * invocation on which turn produced the state. Without a trace these bugs
 * are effectively undebuggable — the state file shows what's there now, the
 * markdown transcript shows the narrative flow, neither explains who wrote
 * what when.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SubagentToolCall {
  tool: string;
  args: unknown;
}

export interface SubagentTraceEntry {
  /** Absolute turn number within the session (1-indexed). */
  turn: number;
  /** Subagent type key — e.g. "bookkeeper", "continuity-checker". */
  subagent: string;
  /** Input passed to the subagent. Callers should pre-truncate large
   *  text fields (~400 chars) to keep the JSONL file manageable. */
  input: unknown;
  /** Tool calls the subagent made, in order, with full args. */
  toolCalls: SubagentToolCall[];
  /** Optional one-line summary of what the subagent did. */
  summary?: string;
  /** Wall-clock duration of the subagent invocation in ms. */
  durationMs: number;
}

export interface SubagentTrace {
  /** Append one invocation record for the given session. Opens / creates
   *  the JSONL file on first call; subsequent calls append. */
  append(sessionId: string, entry: SubagentTraceEntry): void;
}

function shortId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(0, 8) || "unknown";
}

export function createSubagentTrace(stateDir: string): SubagentTrace {
  const transcriptsDir = path.join(stateDir, "transcripts");

  return {
    append(sessionId, entry) {
      fs.mkdirSync(transcriptsDir, { recursive: true });
      const filePath = path.join(
        transcriptsDir,
        `${shortId(sessionId)}.subagents.jsonl`
      );
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      });
      fs.appendFileSync(filePath, line + "\n");
    },
  };
}
