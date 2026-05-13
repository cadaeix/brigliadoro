import { describe, it, expect } from "vitest";
import {
  matchCommand,
  unknownCommandMessage,
  COMMAND_HELP,
} from "../../src/runner/commands.js";

/**
 * Tests for the slash-command matcher used at every player-input
 * prompt site. The invariant under test: anything starting with `/`
 * gets classified (known kind or `unknown`) and never passes through
 * to the LLM as a turn. Non-slash input returns `null` so the caller
 * routes it to the LLM normally.
 */
describe("matchCommand", () => {
  it("returns null for non-slash input (normal turns)", () => {
    expect(matchCommand("Frankie. Charming.")).toBeNull();
    expect(matchCommand("I open the door")).toBeNull();
    expect(matchCommand("")).toBeNull();
    expect(matchCommand("   ")).toBeNull();
    expect(matchCommand("hello")).toBeNull();
  });

  it("returns null for input that contains a slash but doesn't start with one", () => {
    // A player saying "I/we will check the door" or "yes/no" shouldn't
    // be mistaken for a command.
    expect(matchCommand("I/we open the door")).toBeNull();
    expect(matchCommand("either/or")).toBeNull();
  });

  it("classifies /quit", () => {
    expect(matchCommand("/quit")).toEqual({ kind: "quit", raw: "/quit" });
  });

  it("classifies /new", () => {
    expect(matchCommand("/new")).toEqual({ kind: "new", raw: "/new" });
  });

  it("classifies /new-session", () => {
    expect(matchCommand("/new-session")).toEqual({
      kind: "new-session",
      raw: "/new-session",
    });
  });

  it("is case-insensitive on the command name", () => {
    expect(matchCommand("/QUIT").kind).toBe("quit");
    expect(matchCommand("/Quit").kind).toBe("quit");
    expect(matchCommand("/NEW").kind).toBe("new");
    expect(matchCommand("/New-Session").kind).toBe("new-session");
  });

  it("trims surrounding whitespace", () => {
    expect(matchCommand("  /quit  ")).toEqual({ kind: "quit", raw: "/quit" });
    expect(matchCommand("\t/new\n")).toEqual({ kind: "new", raw: "/new" });
  });

  it("returns 'unknown' for any /-prefixed input that isn't a recognised command", () => {
    // The whole point of the universal interception: typos / unknown
    // commands surface here, not at the LLM via buildInitialPrompt.
    expect(matchCommand("/quti")).toEqual({ kind: "unknown", raw: "/quti" });
    expect(matchCommand("/help")).toEqual({ kind: "unknown", raw: "/help" });
    expect(matchCommand("/save")).toEqual({ kind: "unknown", raw: "/save" });
    expect(matchCommand("/")).toEqual({ kind: "unknown", raw: "/" });
    expect(matchCommand("/new game please")).toEqual({
      kind: "unknown",
      raw: "/new game please",
    });
  });

  it("preserves the verbatim trimmed input in `raw` so the help line can echo it back", () => {
    const result = matchCommand("  /unknownThing  ");
    expect(result).toEqual({ kind: "unknown", raw: "/unknownThing" });
  });
});

describe("unknownCommandMessage", () => {
  it("includes the offending command in the message so the player sees what they typed", () => {
    const msg = unknownCommandMessage("/quti");
    expect(msg).toContain("/quti");
  });

  it("includes the COMMAND_HELP string so the player sees what's available", () => {
    const msg = unknownCommandMessage("/foo");
    expect(msg).toContain(COMMAND_HELP);
  });

  it("formats as a single bracketed line for consistency with other harness output", () => {
    expect(unknownCommandMessage("/foo")).toMatch(/^\[.*\]$/);
  });
});

describe("COMMAND_HELP", () => {
  it("lists every command kind that matchCommand recognises", () => {
    // If this fails because a new command was added without updating
    // COMMAND_HELP, the fix is to update the constant — otherwise the
    // unknown-command path would mis-tell players which commands exist.
    expect(COMMAND_HELP).toContain("/quit");
    expect(COMMAND_HELP).toContain("/new");
    expect(COMMAND_HELP).toContain("/new-session");
  });
});
