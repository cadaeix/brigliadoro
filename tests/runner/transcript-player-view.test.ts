import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTranscriptWriter } from "../../src/runner/transcript.js";

/**
 * Tests for the parallel `state/transcripts/<shortid>.player-view.md`
 * side transcript. The player-view contains only the facilitator
 * narration and the player's inputs — no tool indicators, no tool
 * results, no `<!-- subagent:* -->` blocks. An external player harness
 * (e.g. brigliadoro-roland) feeds this file into a Claude player session
 * so the player only sees what a human player would see.
 */
describe("TranscriptWriter player-view side transcript", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  const SESSION_ID = "abc12345-deadbeef-0000-0000-000000000000";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-playerview-"));
    // Silence the awaiting marker writes that some tests trigger via
    // endFacilitatorTurn — not relevant to player-view assertions.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readPlayerView(t: ReturnType<typeof createTranscriptWriter>): string {
    const p = t.currentPlayerViewPath();
    if (p === null || !fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8");
  }

  function readMain(t: ReturnType<typeof createTranscriptWriter>): string {
    const p = t.currentTranscriptPath();
    if (p === null || !fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8");
  }

  it("creates a sibling player-view.md when the session file is opened", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("Welcome.\n");
    t.endFacilitatorTurn(SESSION_ID);

    const mainPath = t.currentTranscriptPath();
    const playerViewPath = t.currentPlayerViewPath();
    expect(mainPath).not.toBe(null);
    expect(playerViewPath).not.toBe(null);
    expect(playerViewPath).toBe(mainPath!.replace(/\.md$/, ".player-view.md"));
    expect(fs.existsSync(mainPath!)).toBe(true);
    expect(fs.existsSync(playerViewPath!)).toBe(true);
  });

  it("writes the same header to both files", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({
      gameName: "Hallow's Gin",
      mode: "initial",
      seedLabel: "seed=42",
    });
    t.recordFacilitatorChunk("Hello.\n");
    t.endFacilitatorTurn(SESSION_ID);

    const main = readMain(t);
    const playerView = readPlayerView(t);

    // Same header lines.
    expect(playerView).toContain(`# Hallow's Gin`);
    expect(playerView).toContain(`- **Session**: \`${SESSION_ID}\``);
    expect(playerView).toContain("- **Started**:");
    expect(playerView).toContain("- **Seed mode**: `seed=42`");

    // Both files share the header up to the `---` separator.
    const mainHeader = main.split("\n---\n\n")[0];
    const pvHeader = playerView.split("\n---\n\n")[0];
    expect(pvHeader).toBe(mainHeader);
  });

  it("includes facilitator narration and player inputs only — no tool calls, results, or subagent blocks", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });

    // A realistic turn sequence: facilitator narrates, calls a tool,
    // tool returns, more narration, bookkeeper writes summary, player
    // responds.
    t.recordFacilitatorChunk("The crows watch you. ");
    t.recordToolCall("risky_roll", ` "investigate the scene"`);
    t.recordToolResult("risky_roll", `{"outcome_tier":"partial","value":3}`);
    t.recordFacilitatorChunk("You find a button.\n");
    t.recordSubagentSummary(
      "bookkeeper",
      [{ tool: "npcs.upsert", args: { name: "Inspector Hardy" } }],
      "Added Inspector Hardy to npcs book."
    );
    t.endFacilitatorTurn(SESSION_ID);
    t.recordPlayerInput("I pick up the button and inspect it");

    const playerView = readPlayerView(t);
    const main = readMain(t);

    // Player-view contains the narrative beats.
    expect(playerView).toContain("The crows watch you.");
    expect(playerView).toContain("You find a button.");
    expect(playerView).toContain("> I pick up the button and inspect it");

    // Player-view does NOT contain any mechanical or bookkeeping noise.
    expect(playerView).not.toContain("↪");
    expect(playerView).not.toContain("risky_roll");
    expect(playerView).not.toContain("outcome_tier");
    expect(playerView).not.toContain("<!-- subagent:");
    expect(playerView).not.toContain("bookkeeper");
    expect(playerView).not.toContain("Inspector Hardy"); // bookkeeper note only

    // Main DOES contain all of those.
    expect(main).toContain("↪ risky_roll");
    expect(main).toContain("outcome_tier");
    expect(main).toContain("<!-- subagent:bookkeeper -->");
    expect(main).toContain("Inspector Hardy");
  });

  it("buffers pending player-view writes until the session file opens", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });

    // Write facilitator content BEFORE we know the session id — common
    // for the pre-rendered opening message.
    t.recordFacilitatorChunk("Pre-session opening text.\n");
    t.recordPlayerInput("hello there");

    // Path is still null; nothing on disk yet.
    expect(t.currentPlayerViewPath()).toBe(null);

    // Now end the turn with a session id — both files open, pending flushes.
    t.endFacilitatorTurn(SESSION_ID);

    const playerView = readPlayerView(t);
    expect(playerView).toContain("Pre-session opening text.");
    expect(playerView).toContain("> hello there");
  });

  it("resetForNewSession clears the player-view path and pending buffer", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("First session content.\n");
    t.endFacilitatorTurn(SESSION_ID);

    expect(t.currentPlayerViewPath()).not.toBe(null);

    t.resetForNewSession();

    expect(t.currentPlayerViewPath()).toBe(null);
    expect(t.currentTranscriptPath()).toBe(null);
  });

  it("appends a resume banner to both files on resume mode", () => {
    // First session, write a turn.
    const t1 = createTranscriptWriter(tmp);
    t1.beginSession({ gameName: "Test Game", mode: "initial" });
    t1.recordFacilitatorChunk("First turn.\n");
    t1.endFacilitatorTurn(SESSION_ID);

    // Simulate a separate process resuming — new writer, same session id.
    const t2 = createTranscriptWriter(tmp);
    t2.beginSession({ gameName: "Test Game", mode: "resume" });
    t2.recordFacilitatorChunk("Resumed turn.\n");
    t2.endFacilitatorTurn(SESSION_ID);

    const playerView = readPlayerView(t2);
    expect(playerView).toContain("## Session resumed —");
    expect(playerView).toContain("Resumed turn.");
    // Original content also preserved.
    expect(playerView).toContain("First turn.");
  });

  it("appends a fresh-session banner to both files in fresh-session mode", () => {
    const t1 = createTranscriptWriter(tmp);
    t1.beginSession({ gameName: "Test Game", mode: "initial" });
    t1.recordFacilitatorChunk("Original session.\n");
    t1.endFacilitatorTurn(SESSION_ID);

    const t2 = createTranscriptWriter(tmp);
    t2.beginSession({ gameName: "Test Game", mode: "fresh-session" });
    t2.recordFacilitatorChunk("Fresh session content.\n");
    t2.endFacilitatorTurn(SESSION_ID);

    const playerView = readPlayerView(t2);
    expect(playerView).toContain("## Fresh session in existing world —");
    expect(playerView).toContain("Fresh session content.");
  });
});
