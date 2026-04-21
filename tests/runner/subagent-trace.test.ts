import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSubagentTrace } from "../../src/runner/subagent-trace.js";

describe("createSubagentTrace", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-subagent-trace-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appends one JSON line per entry under state/transcripts/<shortid>.subagents.jsonl", () => {
    const trace = createSubagentTrace(tmp);
    trace.append("abc12345-6789-0000-0000-000000000000", {
      turn: 1,
      subagent: "bookkeeper",
      input: { turnText: "hello", gameContext: { gameName: "Test" } },
      toolCalls: [{ tool: "npcs", args: { operation: "upsert", name: "A" } }],
      summary: "upserted 1 npc",
      durationMs: 123,
    });
    trace.append("abc12345-6789-0000-0000-000000000000", {
      turn: 2,
      subagent: "bookkeeper",
      input: { turnText: "next turn" },
      toolCalls: [],
      durationMs: 45,
    });

    const expected = path.join(tmp, "transcripts", "abc12345.subagents.jsonl");
    expect(fs.existsSync(expected)).toBe(true);

    const lines = fs
      .readFileSync(expected, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.turn).toBe(1);
    expect(first.subagent).toBe("bookkeeper");
    expect(first.toolCalls).toEqual([
      { tool: "npcs", args: { operation: "upsert", name: "A" } },
    ]);
    expect(first.summary).toBe("upserted 1 npc");
    expect(first.durationMs).toBe(123);
    expect(typeof first.timestamp).toBe("string");

    const second = JSON.parse(lines[1]!);
    expect(second.turn).toBe(2);
    expect(second.toolCalls).toEqual([]);
  });

  it("partitions entries by session id into separate files", () => {
    const trace = createSubagentTrace(tmp);
    trace.append("session-aaaaaaaa", {
      turn: 1,
      subagent: "bookkeeper",
      input: {},
      toolCalls: [],
      durationMs: 1,
    });
    trace.append("session-bbbbbbbb", {
      turn: 1,
      subagent: "bookkeeper",
      input: {},
      toolCalls: [],
      durationMs: 1,
    });
    const dir = path.join(tmp, "transcripts");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.startsWith("sessiona"))).toBe(true);
    expect(files.some((f) => f.startsWith("sessionb"))).toBe(true);
  });

  it("handles empty / non-alphanumeric session ids by falling back to 'unknown'", () => {
    const trace = createSubagentTrace(tmp);
    trace.append("", {
      turn: 1,
      subagent: "bookkeeper",
      input: {},
      toolCalls: [],
      durationMs: 1,
    });
    const expected = path.join(tmp, "transcripts", "unknown.subagents.jsonl");
    expect(fs.existsSync(expected)).toBe(true);
  });
});
