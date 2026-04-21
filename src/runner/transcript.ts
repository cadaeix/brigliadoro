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
      write(`\n  ↪ ${name}${hint}\n\n`);
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
