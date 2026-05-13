import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTranscriptWriter } from "../../src/runner/transcript.js";

/**
 * Tests for the `recordDirectorFailure(error, rawText)` method, which
 * surfaces a Director prose-leak inline in the main .md transcript so
 * the bug shape is visible alongside the degraded message rather than
 * lost to the terminal. Pairs with the director-trace JSONL — the .md
 * version is for "scroll the file and read the drift," the JSONL is
 * for programmatic / structured debugging.
 *
 * Player-view file is intentionally untouched on failure: from the
 * player's perspective, the Director never spoke. Failure blocks are
 * an operator concern.
 */
describe("TranscriptWriter.recordDirectorFailure", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  const SESSION_ID = "deadbeef-cafe-0000-0000-000000000000";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-director-failure-"));
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readMain(t: ReturnType<typeof createTranscriptWriter>): string {
    const p = t.currentTranscriptPath();
    if (p === null || !fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8");
  }

  function readPlayerView(t: ReturnType<typeof createTranscriptWriter>): string {
    const p = t.currentPlayerViewPath();
    if (p === null || !fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8");
  }

  it("writes a <!-- director-failure --> block with the error and the raw text fenced", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordDirectorFailure(
      "Director did not return a JSON object. Streamed text: 99 chars; final result: 0 chars.",
      "I understand there's a technical issue. Let me just respond in character: Nicky leans back."
    );
    // Need to flush — recordDirectorFailure on its own doesn't open the
    // file because no sessionId has been seen. End the turn to flush.
    t.endFacilitatorTurn(SESSION_ID);

    const main = readMain(t);
    expect(main).toContain("<!-- director-failure -->");
    expect(main).toContain("- error: Director did not return a JSON object.");
    expect(main).toContain("- raw text below:");
    expect(main).toContain("```");
    expect(main).toContain(
      "I understand there's a technical issue. Let me just respond in character: Nicky leans back."
    );
  });

  it("does not write the failure block to the player-view file", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordDirectorFailure(
      "parse failed",
      "leaked prose the player should never see"
    );
    t.recordFacilitatorChunk(
      "(The Director returned a malformed brief — degraded message)\n"
    );
    t.endFacilitatorTurn(SESSION_ID);

    const playerView = readPlayerView(t);
    expect(playerView).not.toContain("<!-- director-failure -->");
    expect(playerView).not.toContain("leaked prose the player should never see");
    // The degraded message itself does land in the player-view, since
    // recordFacilitatorChunk writes to both files (the player sees the
    // fallback message). That's the player-facing surface; the leak
    // diagnostic is operator-only.
    expect(playerView).toContain("malformed brief");
  });

  it("renders an empty raw text as (empty) so the fenced block stays readable", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordDirectorFailure("empty stream", "");
    t.endFacilitatorTurn(SESSION_ID);

    const main = readMain(t);
    expect(main).toContain("- error: empty stream");
    expect(main).toMatch(/```\n\(empty\)\n```/);
  });

  it("supports multi-line raw text without breaking the fenced block", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    const multiline = "line one\nline two\nline three";
    t.recordDirectorFailure("multi-line drift", multiline);
    t.endFacilitatorTurn(SESSION_ID);

    const main = readMain(t);
    expect(main).toContain("line one");
    expect(main).toContain("line two");
    expect(main).toContain("line three");
    // Exactly one open fence and one close fence in the block.
    const fences = main.match(/^```$/gm);
    expect(fences?.length).toBeGreaterThanOrEqual(2);
  });

  it("collapses whitespace in the error line so multi-line errors stay one-line", () => {
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordDirectorFailure(
      "Narrator brief failed schema validation:\n  - beat: Required\n  - voice_hints: Required",
      "{}"
    );
    t.endFacilitatorTurn(SESSION_ID);

    const main = readMain(t);
    // Error line itself should be on a single markdown line.
    const errorLineMatch = main.match(/- error: .+/);
    expect(errorLineMatch).not.toBeNull();
    expect(errorLineMatch![0]).not.toContain("\n");
    expect(errorLineMatch![0]).toContain("beat: Required");
  });
});
