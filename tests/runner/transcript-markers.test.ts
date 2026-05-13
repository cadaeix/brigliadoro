import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTranscriptWriter } from "../../src/runner/transcript.js";

/**
 * Tests for the external-driver stdout markers emitted by TranscriptWriter.
 * The markers let an external player harness (e.g. brigliadoro-roland)
 * detect turn boundaries via subprocess stdout and discover the live
 * transcript / player-view file paths without watching the filesystem.
 */
describe("TranscriptWriter awaiting markers", () => {
  let tmp: string;
  let stdoutWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-marker-"));
    stdoutWrites = [];
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutWrites.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("emits a bare marker before the session id is known", () => {
    const t = createTranscriptWriter(tmp, { emitAwaitingMarkers: true });
    t.beginSession({ gameName: "Test Game", mode: "initial" });

    expect(t.currentTranscriptPath()).toBe(null);
    expect(t.currentPlayerViewPath()).toBe(null);

    t.emitAwaitingMarker();

    expect(stdoutWrites).toEqual(["<<<BRIGLIADORO-AWAITING>>>\n"]);
  });

  it("is a no-op when emitAwaitingMarkers is false (the default)", () => {
    // Default construction — no opts; matches the human-player path
    // where `npm run play` reads stdin and should never see markers.
    const t = createTranscriptWriter(tmp);
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("Some facilitator text.\n");
    t.endFacilitatorTurn("abc12345-deadbeef-0000-0000-000000000000");

    stdoutWrites.length = 0;
    t.emitAwaitingMarker();
    // Even in the full-path state, emit is silent without the opt-in.
    expect(stdoutWrites).toEqual([]);

    // And explicitly false has the same behaviour as omitting the field.
    const t2 = createTranscriptWriter(tmp, { emitAwaitingMarkers: false });
    t2.beginSession({ gameName: "Test Game", mode: "initial" });
    stdoutWrites.length = 0;
    t2.emitAwaitingMarker();
    expect(stdoutWrites).toEqual([]);
  });

  it("emits a full marker with both paths once the session id is known", () => {
    const t = createTranscriptWriter(tmp, { emitAwaitingMarkers: true });
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("Hello there.\n");
    // endFacilitatorTurn is what opens the transcript file (path becomes known).
    t.endFacilitatorTurn("abc12345-deadbeef-0000-0000-000000000000");

    stdoutWrites.length = 0; // reset; we only care about the marker
    t.emitAwaitingMarker();

    expect(stdoutWrites).toHaveLength(1);
    const marker = stdoutWrites[0];
    expect(marker.startsWith("<<<BRIGLIADORO-AWAITING ")).toBe(true);
    expect(marker.endsWith(">>>\n")).toBe(true);
    expect(marker).toContain("transcript=");
    expect(marker).toContain("player-view=");
  });

  it("marker paths match the actual transcript path and a player-view sibling", () => {
    const t = createTranscriptWriter(tmp, { emitAwaitingMarkers: true });
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("Greetings.\n");
    t.endFacilitatorTurn("abc12345-deadbeef-0000-0000-000000000000");

    const actualTranscriptPath = t.currentTranscriptPath();
    const actualPlayerViewPath = t.currentPlayerViewPath();
    expect(actualTranscriptPath).not.toBe(null);
    expect(actualPlayerViewPath).not.toBe(null);

    // Confirm the transcript file was actually created on disk.
    expect(fs.existsSync(actualTranscriptPath!)).toBe(true);

    // Player-view path should sit next to the transcript and end in
    // `.player-view.md`. Phase-2 will write to this file; Phase-1 only
    // surfaces the path.
    expect(actualPlayerViewPath).toBe(
      actualTranscriptPath!.replace(/\.md$/, ".player-view.md")
    );
    expect(path.dirname(actualPlayerViewPath!)).toBe(
      path.dirname(actualTranscriptPath!)
    );

    stdoutWrites.length = 0;
    t.emitAwaitingMarker();

    const marker = stdoutWrites[0];
    expect(marker).toContain(`transcript=${actualTranscriptPath}`);
    expect(marker).toContain(`player-view=${actualPlayerViewPath}`);
  });

  it("reverts to bare marker after resetForNewSession until next turn ends", () => {
    const t = createTranscriptWriter(tmp, { emitAwaitingMarkers: true });
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("First session.\n");
    t.endFacilitatorTurn("abc12345-deadbeef-0000-0000-000000000000");

    // Confirm we're in the full-marker state.
    stdoutWrites.length = 0;
    t.emitAwaitingMarker();
    expect(stdoutWrites[0]).toContain("transcript=");

    t.resetForNewSession();
    t.beginSession({ gameName: "Test Game", mode: "initial" });

    stdoutWrites.length = 0;
    t.emitAwaitingMarker();
    expect(stdoutWrites).toEqual(["<<<BRIGLIADORO-AWAITING>>>\n"]);
  });

  it("marker parses cleanly via the documented regex", () => {
    const t = createTranscriptWriter(tmp, { emitAwaitingMarkers: true });
    t.beginSession({ gameName: "Test Game", mode: "initial" });
    t.recordFacilitatorChunk("Hi.\n");
    t.endFacilitatorTurn("abc12345-deadbeef-0000-0000-000000000000");

    stdoutWrites.length = 0;
    t.emitAwaitingMarker();

    // The harness will parse this with something like the regex below.
    // Keep this in sync with brigliadoro-roland's parser.
    const re = /^<<<BRIGLIADORO-AWAITING(?:\s+(.+?))?>>>$/;
    const line = stdoutWrites[0].trimEnd();
    const match = line.match(re);
    expect(match).not.toBeNull();
    const kvs = match![1] ?? "";
    const pairs = Object.fromEntries(
      kvs.split(/\s+/).filter(Boolean).map((kv) => {
        const eq = kv.indexOf("=");
        return [kv.slice(0, eq), kv.slice(eq + 1)];
      })
    );
    expect(pairs.transcript).toBeDefined();
    expect(pairs["player-view"]).toBeDefined();
    expect(fs.existsSync(pairs.transcript)).toBe(true);
  });
});
