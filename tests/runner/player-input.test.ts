import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createScriptSource } from "../../src/runner/player-input.js";

describe("createScriptSource", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brig-player-script-"));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeScript(content: string): string {
    const p = path.join(tmp, "script.ndjson");
    fs.writeFileSync(p, content);
    return p;
  }

  it("returns scripted messages in order", async () => {
    const p = writeScript(
      [
        `{"type":"message","text":"I walk into the tavern"}`,
        `{"type":"message","text":"I order a drink"}`,
      ].join("\n")
    );
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("I walk into the tavern");
    expect(await source.prompt("> ")).toBe("I order a drink");
  });

  it("returns /quit once the script is exhausted", async () => {
    const p = writeScript(`{"type":"message","text":"hello"}`);
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("hello");
    expect(await source.prompt("> ")).toBe("/quit");
    expect(await source.prompt("> ")).toBe("/quit");
  });

  it("echoes the prompt + response to stdout for live observation", async () => {
    const p = writeScript(`{"type":"message","text":"I attack"}`);
    const source = createScriptSource(p);
    await source.prompt("\n> ");
    expect(stdoutSpy).toHaveBeenCalledWith("\n> I attack\n");
  });

  it("skips malformed JSON lines with a warning", async () => {
    const p = writeScript(
      [
        `not json at all`,
        `{"type":"message","text":"first real message"}`,
        `{"type":"message"`,
        `{"type":"message","text":"second real message"}`,
      ].join("\n")
    );
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("first real message");
    expect(await source.prompt("> ")).toBe("second real message");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("skips lines with unknown types", async () => {
    const p = writeScript(
      [
        `{"type":"message","text":"kept"}`,
        `{"type":"wait"}`,
        `{"type":"message","text":"also kept"}`,
      ].join("\n")
    );
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("kept");
    expect(await source.prompt("> ")).toBe("also kept");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown type "wait"')
    );
  });

  it("skips lines whose text is not a string", async () => {
    const p = writeScript(
      [
        `{"type":"message","text":"ok"}`,
        `{"type":"message","text":123}`,
        `{"type":"message"}`,
      ].join("\n")
    );
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("ok");
    expect(await source.prompt("> ")).toBe("/quit");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("ignores blank lines silently", async () => {
    const p = writeScript(
      [
        ``,
        `{"type":"message","text":"first"}`,
        ``,
        ``,
        `{"type":"message","text":"second"}`,
        ``,
      ].join("\n")
    );
    const source = createScriptSource(p);
    expect(await source.prompt("> ")).toBe("first");
    expect(await source.prompt("> ")).toBe("second");
  });

  it("throws if the file is missing", () => {
    expect(() => createScriptSource(path.join(tmp, "nope.ndjson"))).toThrow(
      /not found/
    );
  });

  it("throws if the file contains no usable messages", () => {
    const p = writeScript(
      [`# comment`, `{"type":"wait"}`, ``].join("\n")
    );
    expect(() => createScriptSource(p)).toThrow(/no usable messages/);
  });

  it("close() is a no-op that resolves", async () => {
    const p = writeScript(`{"type":"message","text":"hi"}`);
    const source = createScriptSource(p);
    await expect(source.close()).resolves.toBeUndefined();
  });
});
