import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createDirectorTrace,
  truncateForTrace,
  TRUNCATE,
} from "../../src/runner/director-trace.js";
import type { NarratorBrief } from "../../src/runner/narrator-brief.js";

/**
 * Tests for the per-session director-trace JSONL writer. The trace is
 * the load-bearing diagnostic surface for split-agents debugging (Q17 in
 * the open-design-questions doc) — when the Director streams prose
 * instead of JSON, the leaked text needs to land somewhere recoverable
 * or the bug is effectively unobservable from outside the terminal.
 */
describe("createDirectorTrace", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-director-trace-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readLines(filePath: string): unknown[] {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  const SAMPLE_BRIEF: NarratorBrief = {
    beat: { kind: "scene_setup", summary: "Avalon, dim.", intent: "set scene" },
    voice_hints: { persona: "default", tone: "tense", intensity: "medium" },
    constraints: {
      may_voice_pc_dialogue: false,
      may_describe_pc_internal_state: false,
      may_introduce_new_npcs: false,
    },
    excerpts: { relevant_npcs: [] },
    player_input: "I sit down at the bar.",
  };

  it("writes one JSON line per turn under state/transcripts/<shortid>.director.jsonl", () => {
    const trace = createDirectorTrace(tmp);
    trace.append("abc12345-narrator-0000-0000-000000000000", {
      turn: 1,
      director: {
        input: "Player says: I sit down.",
        sessionId: "director-sess-1",
        model: "sonnet",
        toolCalls: [
          {
            tool: "risky_action",
            args: { fiction: "sitting down" },
            result: '{"outcome_tier":"clean"}',
          },
        ],
        rawText: '{"beat":{...}}',
        brief: SAMPLE_BRIEF,
        error: null,
        durationMs: 1200,
      },
      narrator: {
        sessionId: "narrator-sess-1",
        model: "sonnet",
        prose: "The booth creaks under you.",
        durationMs: 800,
      },
    });

    const expected = path.join(
      tmp,
      "transcripts",
      "abc12345.director.jsonl"
    );
    expect(fs.existsSync(expected)).toBe(true);

    const lines = readLines(expected);
    expect(lines).toHaveLength(1);
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.turn).toBe(1);
    expect(typeof entry.timestamp).toBe("string");

    const director = entry.director as Record<string, unknown>;
    expect(director.sessionId).toBe("director-sess-1");
    expect(director.brief).toEqual(SAMPLE_BRIEF);
    expect(director.error).toBeNull();
    expect((director.toolCalls as unknown[])[0]).toMatchObject({
      tool: "risky_action",
      result: '{"outcome_tier":"clean"}',
    });

    const narrator = entry.narrator as Record<string, unknown>;
    expect(narrator.prose).toBe("The booth creaks under you.");
  });

  it("captures Director failures with null narrator + non-null error + leaked rawText", () => {
    const trace = createDirectorTrace(tmp);
    trace.append("director-fail-aaaa-bbbb-cccc-dddd", {
      turn: 3,
      director: {
        input: "Player says: I lie to Danny.",
        sessionId: "director-fail-aaaa-bbbb-cccc-dddd",
        model: "sonnet",
        toolCalls: [],
        // The whole point — Director leaked prose instead of JSON.
        rawText:
          "I understand there's a technical issue. Let me just respond in character: Nicky leans back...",
        brief: null,
        error: "Director did not return a JSON object. Streamed text: 124 chars; final result: 0 chars.",
        durationMs: 5400,
      },
      narrator: null,
    });

    // Session id `director-fail-...` strips dashes to
    // `directorfailaaaa...` — first 8 chars = `director`.
    const expected = path.join(
      tmp,
      "transcripts",
      "director.director.jsonl"
    );
    expect(fs.existsSync(expected)).toBe(true);

    const [entry] = readLines(expected) as Array<Record<string, unknown>>;
    const director = entry.director as Record<string, unknown>;
    expect(director.brief).toBeNull();
    expect(director.error).toMatch(/did not return a JSON object/);
    expect(director.rawText).toMatch(/I understand there's a technical issue/);
    expect(entry.narrator).toBeNull();
  });

  it("appends multiple turns into the same file in arrival order", () => {
    const trace = createDirectorTrace(tmp);
    const sid = "sess-abcd-0000-0000-0000-000000000000";

    for (let turn = 1; turn <= 3; turn++) {
      trace.append(sid, {
        turn,
        director: {
          input: `turn ${turn}`,
          sessionId: sid,
          model: "sonnet",
          toolCalls: [],
          rawText: "{}",
          brief: SAMPLE_BRIEF,
          error: null,
          durationMs: 100 * turn,
        },
        narrator: {
          sessionId: sid,
          model: "sonnet",
          prose: `prose ${turn}`,
          durationMs: 50 * turn,
        },
      });
    }

    const filePath = path.join(tmp, "transcripts", "sessabcd.director.jsonl");
    const lines = readLines(filePath) as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.turn)).toEqual([1, 2, 3]);
  });

  it("partitions entries by session id into separate files", () => {
    const trace = createDirectorTrace(tmp);
    const baseEntry = {
      turn: 1,
      director: {
        input: "x",
        sessionId: "x",
        model: "sonnet",
        toolCalls: [],
        rawText: "{}",
        brief: SAMPLE_BRIEF,
        error: null,
        durationMs: 1,
      },
      narrator: null,
    };
    trace.append("session-aaaaaaaa", baseEntry);
    trace.append("session-bbbbbbbb", baseEntry);

    const files = fs
      .readdirSync(path.join(tmp, "transcripts"))
      .filter((f) => f.endsWith(".director.jsonl"));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.startsWith("sessiona"))).toBe(true);
    expect(files.some((f) => f.startsWith("sessionb"))).toBe(true);
  });

  it("falls back to 'unknown' for empty / non-alphanumeric session ids", () => {
    const trace = createDirectorTrace(tmp);
    trace.append("", {
      turn: 1,
      director: {
        input: "x",
        sessionId: "",
        model: "sonnet",
        toolCalls: [],
        rawText: "",
        brief: null,
        error: "no session",
        durationMs: 0,
      },
      narrator: null,
    });
    const expected = path.join(
      tmp,
      "transcripts",
      "unknown.director.jsonl"
    );
    expect(fs.existsSync(expected)).toBe(true);
  });
});

describe("truncateForTrace", () => {
  it("returns the string unchanged when within the limit", () => {
    expect(truncateForTrace("short", 100)).toBe("short");
    expect(truncateForTrace("exact", 5)).toBe("exact");
  });

  it("appends an ellipsis when over the limit", () => {
    expect(truncateForTrace("0123456789", 4)).toBe("0123…");
  });

  it("uses the documented per-field budgets when paired with TRUNCATE", () => {
    // The truncation budgets are part of the wire-format contract — if
    // they ever change, this assertion reminds us to update the
    // director-trace docstring comment as well.
    expect(TRUNCATE.directorInput).toBe(2000);
    expect(TRUNCATE.directorRawText).toBe(4000);
    expect(TRUNCATE.toolResult).toBe(1000);
    expect(TRUNCATE.narratorProse).toBe(2000);
  });
});
