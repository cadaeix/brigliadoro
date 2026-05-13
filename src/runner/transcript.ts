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
 *
 * A second "player-view" file is written in parallel at
 * `state/transcripts/<shortid>.player-view.md` containing only the
 * facilitator narration and player inputs — no tool indicators, no
 * tool results, no `<!-- subagent:* -->` blocks. This is the file an
 * external player harness (e.g. brigliadoro-roland) feeds into a
 * Claude player session, so the player only sees what a human player
 * would see.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SessionMode = "initial" | "resume" | "fresh-session";

export interface TranscriptWriter {
  /** Call at session start / after a new-session reset. Sets game name,
   *  mode, and optional seed-mode label shown in the transcript header. */
  beginSession(opts: { gameName: string; mode: SessionMode; seedLabel?: string }): void;
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
  /** Current absolute path of the main transcript file, or null if the
   *  file hasn't been opened yet (no sessionId known). Exposed so the
   *  awaiting marker can include it for external drivers. */
  currentTranscriptPath(): string | null;
  /** Current absolute path of the player-view side transcript (clean
   *  facilitator-prose-only view for external player agents). Returns
   *  null before the session file is opened. */
  currentPlayerViewPath(): string | null;
  /** Emit a turn-boundary marker to stdout for external drivers (e.g. an
   *  LLM-player harness). Should be called immediately before
   *  `playerSource.prompt()` at every prompt site. The marker carries
   *  the transcript paths when known; emits a bare marker when the
   *  session id isn't yet established (very first prompt of a session). */
  emitAwaitingMarker(): void;
}

export interface TranscriptWriterOptions {
  /** When true, `emitAwaitingMarker()` writes the
   *  `<<<BRIGLIADORO-AWAITING ...>>>` line to stdout. When false (the
   *  default), the method is a no-op.
   *
   *  External-driver scenarios (e.g. brigliadoro-roland tailing the
   *  subprocess stdout) need the markers; human players running
   *  `npm run play` don't, and would see the line as visual noise.
   *
   *  play.ts wires this to `args.playerScriptTailPath !== undefined` —
   *  tail mode is the seam external drivers use, so it's a clean
   *  proxy for "I'm being driven by something that wants markers."
   *  If a non-tail driver use case turns up later, add an explicit
   *  `--emit-markers` flag rather than broadening this heuristic. */
  emitAwaitingMarkers?: boolean;
}

export function createTranscriptWriter(
  stateDir: string,
  options: TranscriptWriterOptions = {}
): TranscriptWriter {
  const transcriptsDir = path.join(stateDir, "transcripts");
  const emitAwaitingMarkers = options.emitAwaitingMarkers ?? false;
  let gameName = "TTRPG Runner";
  let mode: SessionMode = "initial";
  let seedLabel: string | undefined;

  // Main transcript: everything (facilitator, player, tool calls, subagent
  // summaries). Player view: only facilitator narration + player inputs.
  // Both files share the same header and are opened together once the
  // session id is known.
  let filePath: string | null = null;
  let playerViewPath: string | null = null;
  let pending: string[] = [];
  let playerViewPending: string[] = [];

  function write(chunk: string): void {
    if (filePath) {
      fs.appendFileSync(filePath, chunk);
    } else {
      pending.push(chunk);
    }
  }

  function writePlayerView(chunk: string): void {
    if (playerViewPath) {
      fs.appendFileSync(playerViewPath, chunk);
    } else {
      playerViewPending.push(chunk);
    }
  }

  function writeBoth(chunk: string): void {
    write(chunk);
    writePlayerView(chunk);
  }

  function flushPending(): void {
    if (filePath && pending.length > 0) {
      fs.appendFileSync(filePath, pending.join(""));
      pending = [];
    }
    if (playerViewPath && playerViewPending.length > 0) {
      fs.appendFileSync(playerViewPath, playerViewPending.join(""));
      playerViewPending = [];
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

  function playerViewPathFor(transcriptPath: string): string {
    // Mirror the transcript path with a `.player-view.md` suffix so the
    // two files sit next to each other in the same directory and share
    // a discoverable naming convention.
    return transcriptPath.replace(/\.md$/, ".player-view.md");
  }

  function buildNewSessionHeader(sessionId: string, now: string): string {
    const seedLine = seedLabel ? `- **Seed mode**: \`${seedLabel}\`\n` : "";
    return (
      `# ${gameName}\n\n` +
      `- **Session**: \`${sessionId}\`\n` +
      `- **Started**: ${now}\n` +
      seedLine +
      `\n---\n\n`
    );
  }

  function buildResumeBanner(now: string): string {
    const seedLine = seedLabel ? ` (seed mode: \`${seedLabel}\`)` : "";
    return `\n---\n\n## Session resumed — ${now}${seedLine}\n\n`;
  }

  function buildFreshSessionBanner(now: string): string {
    const seedLine = seedLabel ? ` (seed mode: \`${seedLabel}\`)` : "";
    return `\n---\n\n## Fresh session in existing world — ${now}${seedLine}\n\n`;
  }

  /** Open both the main transcript and the player-view file for this
   *  session id. They share a header (or resume / fresh-session banner)
   *  so the player-view reads as a parallel record of the same session. */
  function openFilesFor(sessionId: string): { main: string; playerView: string } {
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const main = path.join(transcriptsDir, `${shortId(sessionId)}.md`);
    const playerView = playerViewPathFor(main);
    const mainExists = fs.existsSync(main);
    const playerViewExists = fs.existsSync(playerView);
    const now = new Date().toISOString();

    if (!mainExists) {
      fs.writeFileSync(main, buildNewSessionHeader(sessionId, now));
    } else if (mode === "resume") {
      fs.appendFileSync(main, buildResumeBanner(now));
    } else if (mode === "fresh-session") {
      fs.appendFileSync(main, buildFreshSessionBanner(now));
    }

    // The player-view header mirrors the main header (and resume / fresh
    // banners) so the two read in parallel. New-file initialization is
    // independent of the main file in case a previous run wrote one but
    // not the other (e.g. crash between writes).
    if (!playerViewExists) {
      fs.writeFileSync(playerView, buildNewSessionHeader(sessionId, now));
    } else if (mode === "resume") {
      fs.appendFileSync(playerView, buildResumeBanner(now));
    } else if (mode === "fresh-session") {
      fs.appendFileSync(playerView, buildFreshSessionBanner(now));
    }

    return { main, playerView };
  }

  return {
    beginSession(opts) {
      gameName = opts.gameName;
      mode = opts.mode;
      seedLabel = opts.seedLabel;
    },
    recordPlayerInput(text) {
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      // Player input goes to both files — the player-view needs the
      // player's own line for context (so a player agent reading the
      // file sees its own prior turn echoed).
      writeBoth(`\n${quoted}\n\n`);
    },
    recordFacilitatorChunk(chunk) {
      // Facilitator narration is the whole point of the player-view.
      writeBoth(chunk);
    },
    recordToolCall(name, hint) {
      // Main only — tool indicators are mechanical noise an external
      // player agent shouldn't see (a human player wouldn't).
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
      // Main only — tool results are the deepest layer of mechanical
      // detail; never visible to a player.
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
      // Main only — bookkeeper / future-specialist activity is bookkeeping,
      // not narrative.
      write(lines.join("\n"));
    },
    endFacilitatorTurn(sessionId) {
      if (!filePath && sessionId) {
        const opened = openFilesFor(sessionId);
        filePath = opened.main;
        playerViewPath = opened.playerView;
        flushPending();
      }
      writeBoth("\n");
    },
    resetForNewSession() {
      filePath = null;
      playerViewPath = null;
      pending = [];
      playerViewPending = [];
    },
    currentTranscriptPath() {
      return filePath;
    },
    currentPlayerViewPath() {
      return playerViewPath;
    },
    emitAwaitingMarker() {
      // No-op unless an external driver has explicitly opted in via the
      // factory option. Human players running `npm run play` directly
      // don't want the marker line cluttering their session.
      if (!emitAwaitingMarkers) return;

      // External drivers (e.g. an LLM-player harness) parse this marker
      // on stdout to detect when it's the player's turn. Format is
      // designed for simple regex parsing — key=value pairs space-separated.
      // Bare marker (no kwargs) is emitted before the session id is known
      // (first prompt of a session, before the first facilitator turn has
      // generated one); harnesses must handle this case by reading the
      // opening message from stdout buffer instead of from file.
      if (filePath === null || playerViewPath === null) {
        process.stdout.write("<<<BRIGLIADORO-AWAITING>>>\n");
        return;
      }
      process.stdout.write(
        `<<<BRIGLIADORO-AWAITING transcript=${filePath} player-view=${playerViewPath}>>>\n`
      );
    },
  };
}
