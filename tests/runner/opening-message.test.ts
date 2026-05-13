import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { presentOpeningMessage } from "../../src/runner/opening-message.js";
import { createTranscriptWriter } from "../../src/runner/transcript.js";
import type { PlayerInputSource } from "../../src/runner/player-input.js";

/**
 * Tests for `presentOpeningMessage`'s command-interception logic.
 *
 * The bug we're guarding against: a player who types `/new` at the
 * opening prompt — typically defensive ("did the wipe actually
 * happen?") — used to have `"/new"` passed to the LLM as their first
 * response via `buildInitialPrompt`. The agent then improvised a
 * meta-narrative reply about starting fresh, instead of the player
 * getting a genuine do-over. /quit had this protection already; /new
 * is symmetrical and now gets the same treatment.
 *
 * Scope: just `presentOpeningMessage` in isolation. The loop logic
 * that handles the `new-command` outcome (wipe + re-show) lives in
 * play.ts and is exercised via the runner integration path, not here.
 */
describe("presentOpeningMessage command interception", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-opening-msg-"));
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A minimal scripted PlayerInputSource that returns a single
   *  pre-canned line on `prompt()` and never reads anything else. */
  function fixedInputSource(line: string): PlayerInputSource {
    return {
      async prompt() {
        return line;
      },
      async close() {},
    };
  }

  it("returns new-command when the player types /new at the opening prompt", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const outcome = await presentOpeningMessage({
      openingMessage: "Welcome to the bar.\nWhat's your name?",
      playerSource: fixedInputSource("/new"),
      transcript,
    });

    expect(outcome).toEqual({ kind: "new-command" });
  });

  it("does NOT record /new as a player input (it's a user-side command, not a turn)", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    await presentOpeningMessage({
      openingMessage: "Opening text.",
      playerSource: fixedInputSource("/new"),
      transcript,
    });

    // Flush the transcript to disk by ending a (fake) facilitator turn.
    // Then read back: the /new should not appear anywhere as a player
    // input — if it did, it would be passed to buildInitialPrompt at
    // the next LLM turn, which is exactly the bug.
    transcript.endFacilitatorTurn("test-session-1234");
    const mainPath = transcript.currentTranscriptPath()!;
    const main = fs.readFileSync(mainPath, "utf-8");
    expect(main).toContain("Opening text.");
    expect(main).not.toContain("> /new");
    expect(main).not.toContain("/new");
  });

  it("case-insensitive: /NEW and /New both return new-command", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const upper = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: fixedInputSource("/NEW"),
      transcript,
    });
    expect(upper.kind).toBe("new-command");

    const mixed = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: fixedInputSource("/New"),
      transcript,
    });
    expect(mixed.kind).toBe("new-command");
  });

  it("trims whitespace around /new", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const outcome = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: fixedInputSource("  /new  "),
      transcript,
    });
    expect(outcome.kind).toBe("new-command");
  });

  it("still recognises /quit at the opening prompt", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const outcome = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: fixedInputSource("/quit"),
      transcript,
    });
    expect(outcome).toEqual({ kind: "quit" });
  });

  it("passes a normal response through as { kind: 'responded' } with the verbatim text", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const outcome = await presentOpeningMessage({
      openingMessage: "What's your nickname?",
      playerSource: fixedInputSource("Frankie. Charming but jittery."),
      transcript,
    });

    expect(outcome).toEqual({
      kind: "responded",
      text: "Frankie. Charming but jittery.",
    });
  });

  it("returns no-opening when openingMessage is undefined (without consuming player input)", async () => {
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    let consumed = false;
    const source: PlayerInputSource = {
      async prompt() {
        consumed = true;
        return "anything";
      },
      async close() {},
    };

    const outcome = await presentOpeningMessage({
      openingMessage: undefined,
      playerSource: source,
      transcript,
    });

    expect(outcome).toEqual({ kind: "no-opening" });
    expect(consumed).toBe(false);
  });

  it("returns new-session-command when the player types /new-session at the opening prompt", async () => {
    // At the opening prompt /new-session is essentially equivalent
    // to /new (no session yet to drop), but the caller distinguishes
    // them for status-line wording — /new-session preserves state,
    // /new wipes it. The intercept is the load-bearing part: without
    // it, "/new-session" gets passed to the LLM as a first response.
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    const outcome = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: fixedInputSource("/new-session"),
      transcript,
    });
    expect(outcome).toEqual({ kind: "new-session-command" });
  });

  it("loops on unknown commands internally — re-prompts until a real input or known command arrives", async () => {
    // Unknown commands print a help line and re-prompt at the same
    // opening (without re-rendering the opening text). The harness
    // never sees them; the LLM definitely never sees them.
    const transcript = createTranscriptWriter(tmp);
    transcript.beginSession({ gameName: "Test", mode: "initial" });

    // Scripted source that returns /unknown1, then /quti, then a real
    // response. The presentOpeningMessage loop should consume the
    // first two as unknowns and return on the third.
    const responses = ["/unknown1", "/quti", "Frankie"];
    let i = 0;
    const source: PlayerInputSource = {
      async prompt() {
        return responses[i++]!;
      },
      async close() {},
    };

    const outcome = await presentOpeningMessage({
      openingMessage: "Opening.",
      playerSource: source,
      transcript,
    });
    expect(outcome).toEqual({ kind: "responded", text: "Frankie" });

    // All three prompts were consumed.
    expect(i).toBe(3);

    // None of the unknowns leaked into the transcript as player input.
    transcript.endFacilitatorTurn("test-session-1234");
    const main = fs.readFileSync(transcript.currentTranscriptPath()!, "utf-8");
    expect(main).not.toContain("/unknown1");
    expect(main).not.toContain("/quti");
    expect(main).toContain("> Frankie");
  });
});
