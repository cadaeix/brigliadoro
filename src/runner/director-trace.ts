/**
 * Per-session JSONL trace log for the Director/Narrator split runtime.
 *
 * One line per turn at `state/transcripts/<shortid>.director.jsonl`,
 * paired with the markdown transcript by short id. Each line carries
 * the Director half (input, tool calls, raw streamed text, parsed
 * brief, error, timing, session id) and the Narrator half (brief that
 * was sent, prose written back, session id, timing). On Director
 * failure the Narrator half is `null` (no Narrator call was made).
 *
 * Why a parallel file rather than reusing `subagents.jsonl`:
 *
 * - The Director and Narrator are the primary play agents, not Haiku
 *   specialists — `subagents.jsonl` is "what did the bookkeeper /
 *   continuity-checker / future-Haiku-specialist do this turn."
 *   Mixing the two would muddle that file's purpose.
 * - The Director-side debug surface is shaped differently: we care
 *   about *raw streamed text* (especially on parse failure — Q17) and
 *   *the parsed brief* (what the Narrator was actually told to do).
 *   Neither fits the subagent-trace's `{ toolCalls, summary }` shape.
 *
 * Why one line covers both Director + Narrator:
 *
 * - One Director call → one Narrator call per turn. Splitting them
 *   would make turn-aligned reading awkward (need to join two streams
 *   by turn number). Keeping them together means `tail -f` shows the
 *   full turn at a glance.
 *
 * The trace is grep-friendly (one JSON object per line) and crash-safe
 * (append-only — a partial write can only corrupt the line being
 * written, never prior records). Same shape as `subagent-trace.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { NarratorBrief } from "./narrator-brief.js";

export interface DirectorToolCall {
  /** MCP tool name with `mcp__<server>__` prefix stripped. */
  tool: string;
  /** Full args object the Director passed — useful for replaying
   *  tool calls during debug, or diffing args across regens. */
  args: unknown;
  /** Tool result text (truncated by the caller for storage budget).
   *  Optional because the SDK can drop tool_result blocks if the
   *  result fell off the stream. */
  result?: string;
}

export interface DirectorTraceDirector {
  /** Full user prompt sent to the Director (the per-turn input,
   *  pre-truncated by the caller to keep lines manageable). */
  input: string;
  sessionId: string;
  /** Sonnet / Opus / Haiku — usually "sonnet" per the plan. */
  model: string;
  toolCalls: DirectorToolCall[];
  /** The Director's streamed assistant text (truncated by the caller).
   *  On success this is the JSON brief; on failure it's whatever prose
   *  the model emitted instead. The whole point of this file is being
   *  able to see this on failure. */
  rawText: string;
  /** The parsed brief, present when the Director's output parsed
   *  cleanly. `null` when parsing failed; in that case `error` carries
   *  the diagnostic. */
  brief: NarratorBrief | null;
  /** Parse / schema-validation error, when the brief failed. `null`
   *  when the Director succeeded. */
  error: string | null;
  durationMs: number;
}

export interface DirectorTraceNarrator {
  sessionId: string;
  model: string;
  /** The Narrator's prose output (truncated by the caller). Full prose
   *  is already in the markdown transcript — this is for at-a-glance
   *  pairing with the brief that produced it. */
  prose: string;
  durationMs: number;
}

export interface DirectorTraceEntry {
  /** 1-indexed turn number within the session. Matches the turn number
   *  in the paired `subagents.jsonl` so the two files line up. */
  turn: number;
  director: DirectorTraceDirector;
  /** `null` when the Director failed — no Narrator call was made. */
  narrator: DirectorTraceNarrator | null;
}

export interface DirectorTrace {
  /** Append one turn record. Opens / creates the JSONL file on first
   *  call; subsequent calls append. */
  append(sessionId: string, entry: DirectorTraceEntry): void;
}

function shortId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(0, 8) || "unknown";
}

export function createDirectorTrace(stateDir: string): DirectorTrace {
  const transcriptsDir = path.join(stateDir, "transcripts");

  return {
    append(sessionId, entry) {
      fs.mkdirSync(transcriptsDir, { recursive: true });
      const filePath = path.join(
        transcriptsDir,
        `${shortId(sessionId)}.director.jsonl`
      );
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      });
      fs.appendFileSync(filePath, line + "\n");
    },
  };
}

// Truncation budgets used by callers when assembling entries. Centralised
// here so the wire-format documentation lives next to the schema rather
// than scattered across the Director / Narrator / split-turn-runner files.
//
// Director input prompts can be the full first-turn framing block; cap at
// 2KB. Raw text on failure can be a whole paragraph of leaked prose; cap
// generously at 4KB so you can read the whole drift. Tool results land at
// 1KB each (more generous than the transcript's 500-char cap because the
// trace is the diagnostic surface). Narrator prose: 2KB — full prose
// already lives in the .md transcript next door.
export const TRUNCATE = {
  directorInput: 2000,
  directorRawText: 4000,
  toolResult: 1000,
  narratorProse: 2000,
} as const;

/** Truncate a string with a trailing ellipsis when it exceeds `max`. */
export function truncateForTrace(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
