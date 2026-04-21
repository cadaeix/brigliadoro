/**
 * Append-only play-session transcript logger.
 *
 * Writes a human-readable markdown transcript of each play session to
 * `state/transcripts/<first-8-chars-of-session-id>.md`. One file per
 * Claude Agent SDK session id, so resumes keep appending to the same file.
 *
 * Format:
 *
 *   # <game name>
 *
 *   - **Session**: `<full-uuid>`
 *   - **Started**: 2026-04-22T14:30:00.000Z
 *
 *   ---
 *
 *   Welcome to the game...   ← facilitator text streams here
 *
 *     ↪ character_sheets.upsert "Boris Bentley"   ← tool-call indicators
 *
 *   > i charge at the goblin   ← player input as a markdown blockquote
 *
 *   You swing your sword...
 *
 * Writes are append-only and per-chunk flushed so ctrl+C never loses
 * what happened. Tool call results are NOT captured — too verbose;
 * the indicator line is enough for reading + debugging.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SessionMode = "initial" | "resume" | "fresh-session";

export interface TranscriptWriter {
  /** Call at session start / after a new-session reset. Sets game name + mode. */
  beginSession(opts: { gameName: string; mode: SessionMode }): void;
  /** Record a line of player input (what the human typed). */
  recordPlayerInput(text: string): void;
  /** Record a streamed chunk of facilitator text. */
  recordFacilitatorChunk(chunk: string): void;
  /** Record a tool call being made by the facilitator. */
  recordToolCall(name: string, hint: string): void;
  /** Record a tool's returned result, for debug visibility. `resultText`
   *  is the raw text payload from the MCP tool_result block; usually a
   *  JSON-serialized structuredContent. */
  recordToolResult(name: string, resultText: string): void;
  /** Append a summary of what a subagent (bookkeeper etc.) did this turn,
   *  under a `<!-- subagent:<name> -->` marker. Indented to visually
   *  distinguish specialist work from facilitator narration. */
  recordSubagentSummary(subagent: string, toolCalls: Array<{ tool: string; args: unknown }>, summary?: string): void;
  /** Call at end of a facilitator turn. Opens the file on first call
   *  (once we have a sessionId) and flushes any buffered content. */
  endFacilitatorTurn(sessionId: string): void;
  /** Reset state for a new transcript (e.g. /new, /new-session). */
  resetForNewSession(): void;
}

export function createTranscriptWriter(stateDir: string): TranscriptWriter {
  const transcriptsDir = path.join(stateDir, "transcripts");
  let gameName = "TTRPG Runner";
  let mode: SessionMode = "initial";
  let filePath: string | null = null;
  let pending: string[] = [];

  function write(chunk: string): void {
    if (filePath) {
      fs.appendFileSync(filePath, chunk);
    } else {
      pending.push(chunk);
    }
  }

  function flushPending(): void {
    if (filePath && pending.length > 0) {
      fs.appendFileSync(filePath, pending.join(""));
      pending = [];
    }
  }

  /** Extract an identifying snippet from a tool-call's args for the
   *  subagent-summary line. Mirrors the inline indicator pattern used for
   *  facilitator tool calls in play.ts — primary (name/operation) first,
   *  then a control field (operation/action) if different. */
  function summariseArgs(args: unknown): string {
    if (!args || typeof args !== "object") return "";
    const a = args as Record<string, unknown>;
    const pick = (k: string): string | null => {
      const v = a[k];
      return typeof v === "string" && v ? v : null;
    };
    const primary = pick("name") ?? pick("description") ?? null;
    const operation = pick("operation") ?? null;
    const parts: string[] = [];
    if (operation) parts.push(operation);
    if (primary) parts.push(primary);
    if (parts.length === 0) return "";
    const joined = parts.join(" ");
    const max = 80;
    return ` ${JSON.stringify(joined.length > max ? joined.slice(0, max) + "…" : joined)}`;
  }

  function shortId(sessionId: string): string {
    const cleaned = sessionId.replace(/[^a-zA-Z0-9]/g, "");
    return cleaned.slice(0, 8) || "unknown";
  }

  function openFileFor(sessionId: string): string {
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const p = path.join(transcriptsDir, `${shortId(sessionId)}.md`);
    const exists = fs.existsSync(p);
    const now = new Date().toISOString();

    if (!exists) {
      const header =
        `# ${gameName}\n\n` +
        `- **Session**: \`${sessionId}\`\n` +
        `- **Started**: ${now}\n\n` +
        `---\n\n`;
      fs.writeFileSync(p, header);
    } else if (mode === "resume") {
      fs.appendFileSync(p, `\n---\n\n## Session resumed — ${now}\n\n`);
    } else if (mode === "fresh-session") {
      // New session in an existing world (session-id changed but world kept)
      fs.appendFileSync(p, `\n---\n\n## Fresh session in existing world — ${now}\n\n`);
    }
    return p;
  }

  return {
    beginSession(opts) {
      gameName = opts.gameName;
      mode = opts.mode;
    },
    recordPlayerInput(text) {
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      write(`\n${quoted}\n\n`);
    },
    recordFacilitatorChunk(chunk) {
      write(chunk);
    },
    recordToolCall(name, hint) {
      // No trailing newline-pair — the result line will append on the next
      // line below this one, then add its own spacing.
      write(`\n  ↪ ${name}${hint}\n`);
    },
    recordToolResult(_name, resultText) {
      // Re-serialize JSON compactly if possible; fall back to raw text.
      let rendered = resultText;
      try {
        const parsed = JSON.parse(resultText);
        rendered = JSON.stringify(parsed);
      } catch {
        /* not JSON, use raw */
      }
      // Truncate aggressively — most tool returns fit in 500 chars; the rare
      // verbose one gets a "…" marker. Full payloads aren't needed in the
      // markdown transcript; we care about outcome_tier, flags, key tokens.
      const max = 500;
      const truncated =
        rendered.length > max ? rendered.slice(0, max) + "…" : rendered;
      write(`  ← ${truncated}\n\n`);
    },
    recordSubagentSummary(subagent, toolCalls, summary) {
      if (toolCalls.length === 0 && !summary) return;
      const lines: string[] = [`\n<!-- subagent:${subagent} -->`];
      for (const call of toolCalls) {
        const hint = summariseArgs(call.args);
        lines.push(`- ${call.tool}${hint}`);
      }
      if (summary) {
        const trimmed = summary.trim();
        if (trimmed) lines.push(`  > ${trimmed.slice(0, 200)}`);
      }
      lines.push("");
      write(lines.join("\n"));
    },
    endFacilitatorTurn(sessionId) {
      if (!filePath && sessionId) {
        filePath = openFileFor(sessionId);
        flushPending();
      }
      write("\n");
    },
    resetForNewSession() {
      filePath = null;
      pending = [];
    },
  };
}
