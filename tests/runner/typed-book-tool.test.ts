import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTypedBookTool } from "../../src/runner/typed-book-tool.js";

// Small shared shape used by most tests.
const testShape = {
  summary: z.string().optional().describe("one-liner"),
  disposition: z.enum(["friendly", "neutral", "hostile"]).optional().describe("stance"),
  tags: z.array(z.string()).max(10).optional().describe("tags"),
  notes: z.string().optional().describe("markdown bucket"),
} as const;

function makeTool(stateDir: string, overrides: Partial<Parameters<typeof createTypedBookTool>[0]> = {}) {
  return createTypedBookTool({
    name: "npcs",
    description: "test book",
    filename: "npcs.json",
    stateDir,
    recordShape: testShape,
    ...overrides,
  });
}

describe("createTypedBookTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-typed-book-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("list on empty store returns empty", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "list" }, {});
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { entries: unknown[] }).entries).toEqual([]);
  });

  it("upsert creates a record", async () => {
    const t = makeTool(tmp);
    const r = await t.handler(
      { operation: "upsert", name: "Elin", patch: { summary: "dockmaster", disposition: "friendly" } },
      {}
    );
    expect(r.isError).toBeFalsy();
    const rec = (r.structuredContent as { record: Record<string, unknown> }).record;
    expect(rec).toEqual({ name: "Elin", summary: "dockmaster", disposition: "friendly" });
    // Persisted to disk
    const fileData = JSON.parse(fs.readFileSync(path.join(tmp, "npcs.json"), "utf-8"));
    expect(fileData.records.Elin).toEqual({ summary: "dockmaster", disposition: "friendly" });
  });

  it("upsert shallow-merges — unmentioned fields preserved", async () => {
    const t = makeTool(tmp);
    await t.handler(
      { operation: "upsert", name: "Elin", patch: { summary: "dockmaster", disposition: "friendly" } },
      {}
    );
    await t.handler({ operation: "upsert", name: "Elin", patch: { notes: "owes the PC a favour" } }, {});
    const r = await t.handler({ operation: "get", name: "Elin" }, {});
    expect((r.structuredContent as { record: Record<string, unknown> }).record).toEqual({
      name: "Elin",
      summary: "dockmaster",
      disposition: "friendly",
      notes: "owes the PC a favour",
    });
  });

  it("upsert replaces array fields wholesale", async () => {
    const t = makeTool(tmp);
    await t.handler({ operation: "upsert", name: "Elin", patch: { tags: ["sailor", "old"] } }, {});
    await t.handler({ operation: "upsert", name: "Elin", patch: { tags: ["friend"] } }, {});
    const r = await t.handler({ operation: "get", name: "Elin" }, {});
    expect((r.structuredContent as { record: { tags: string[] } }).record.tags).toEqual(["friend"]);
  });

  it("upsert returns error when name is missing", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "upsert", patch: { summary: "x" } }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("missing_name");
  });

  it("upsert returns error when patch is missing", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "upsert", name: "Elin" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("missing_patch");
  });

  it("get returns error when name is missing", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "get" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("missing_name");
  });

  it("get returns not_found for unknown record", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "get", name: "Nobody" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string; name: string }).error).toBe("not_found");
    expect((r.structuredContent as { error: string; name: string }).name).toBe("Nobody");
  });

  it("list returns names + summaries only, not full records", async () => {
    const t = makeTool(tmp);
    await t.handler({ operation: "upsert", name: "Elin", patch: { summary: "dockmaster", notes: "long note" } }, {});
    await t.handler({ operation: "upsert", name: "Torq", patch: { summary: "brawler" } }, {});
    const r = await t.handler({ operation: "list" }, {});
    const entries = (r.structuredContent as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Elin", summary: "dockmaster" });
    expect(entries[1]).toEqual({ name: "Torq", summary: "brawler" });
    // Notes should NOT appear in the list view.
    for (const e of entries) {
      expect("notes" in e).toBe(false);
    }
  });

  it("list returns null summary for records without one", async () => {
    const t = makeTool(tmp);
    await t.handler({ operation: "upsert", name: "Mystery", patch: { notes: "unnamed yet" } }, {});
    const r = await t.handler({ operation: "list" }, {});
    const entries = (r.structuredContent as { entries: Array<{ name: string; summary: string | null }> }).entries;
    expect(entries).toEqual([{ name: "Mystery", summary: null }]);
  });

  it("remove deletes a record", async () => {
    const t = makeTool(tmp);
    await t.handler({ operation: "upsert", name: "Elin", patch: { summary: "dockmaster" } }, {});
    const del = await t.handler({ operation: "remove", name: "Elin" }, {});
    expect(del.isError).toBeFalsy();
    const get = await t.handler({ operation: "get", name: "Elin" }, {});
    expect(get.isError).toBe(true);
    expect((get.structuredContent as { error: string }).error).toBe("not_found");
  });

  it("remove returns not_found for unknown record", async () => {
    const t = makeTool(tmp);
    const r = await t.handler({ operation: "remove", name: "Ghost" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("not_found");
  });

  it("two tool instances over the same stateDir see each other's writes", async () => {
    const a = makeTool(tmp);
    const b = makeTool(tmp);
    await a.handler({ operation: "upsert", name: "Elin", patch: { summary: "dockmaster" } }, {});
    const r = await b.handler({ operation: "get", name: "Elin" }, {});
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { record: { summary: string } }).record.summary).toBe("dockmaster");
  });

  it("handles corrupt JSON without throwing", async () => {
    const t = makeTool(tmp);
    fs.writeFileSync(path.join(tmp, "npcs.json"), "{not valid json");
    const r = await t.handler({ operation: "list" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("corrupt_store");
  });

  it("handles a file that parses but isn't the expected shape", async () => {
    const t = makeTool(tmp);
    fs.writeFileSync(path.join(tmp, "npcs.json"), JSON.stringify({ wrongShape: true }));
    const r = await t.handler({ operation: "list" }, {});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: string }).error).toBe("corrupt_store");
  });

  it("names are case-sensitive", async () => {
    const t = makeTool(tmp);
    await t.handler({ operation: "upsert", name: "Elin", patch: { summary: "Proper Elin" } }, {});
    await t.handler({ operation: "upsert", name: "elin", patch: { summary: "lowercase elin" } }, {});
    const list = await t.handler({ operation: "list" }, {});
    const entries = (list.structuredContent as { entries: Array<{ name: string }> }).entries;
    expect(entries.map((e) => e.name).sort()).toEqual(["Elin", "elin"]);
  });

  it("serialises concurrent upserts — no lost writes", async () => {
    const t = makeTool(tmp);
    // Fire 10 upserts in parallel against distinct names.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.handler({ operation: "upsert", name: `npc-${i}`, patch: { summary: `n${i}` } }, {})
      )
    );
    const list = await t.handler({ operation: "list" }, {});
    const entries = (list.structuredContent as { entries: Array<{ name: string }> }).entries;
    expect(entries).toHaveLength(10);
  });

  it("surfaces a soft size warning on large records", async () => {
    const t = makeTool(tmp, { softRecordSizeBytes: 200 });
    const bigNotes = "x".repeat(500);
    const r = await t.handler(
      { operation: "upsert", name: "Verbose", patch: { notes: bigNotes } },
      {}
    );
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { warning?: string };
    expect(sc.warning).toBeTruthy();
    expect(sc.warning!).toMatch(/> soft cap 200/);
  });

  it("does NOT emit a warning for records under the soft cap", async () => {
    const t = makeTool(tmp, { softRecordSizeBytes: 4096 });
    const r = await t.handler(
      { operation: "upsert", name: "Elin", patch: { summary: "dockmaster" } },
      {}
    );
    expect((r.structuredContent as { warning?: string }).warning).toBeUndefined();
  });

  it("survives when stateDir doesn't yet exist", async () => {
    const freshDir = path.join(tmp, "nested", "state");
    // Do not mkdir — let the tool create it on first write.
    const t = makeTool(freshDir);
    const r = await t.handler(
      { operation: "upsert", name: "Elin", patch: { summary: "dockmaster" } },
      {}
    );
    expect(r.isError).toBeFalsy();
    expect(fs.existsSync(path.join(freshDir, "npcs.json"))).toBe(true);
  });
});
