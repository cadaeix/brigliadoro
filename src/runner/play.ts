/**
 * Generic play harness for Brigliadoro runners.
 *
 * This file is copied into each generated runner at build time.
 * It reads config.json, loads the game's MCP server, builds the
 * facilitator system prompt, and runs an interactive terminal play loop.
 *
 * Usage: npx tsx play.ts
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buildFacilitatorSystemPrompt } from "./lib/runner/facilitator-prompt-template.js";
import { createFacilitatorMemoryTools } from "./lib/runner/facilitator-memory.js";
import { createTranscriptWriter } from "./lib/runner/transcript.js";
import type { TranscriptWriter } from "./lib/runner/transcript.js";
import { runBookkeeper } from "./lib/runner/bookkeeper.js";
import { createSubagentTrace } from "./lib/runner/subagent-trace.js";
import {
  installSeededRng,
  installSequenceRng,
  parseSequenceArg,
} from "./lib/runner/seeded-rng.js";
import {
  createScriptSource,
  createScriptTailSource,
  createStdinSource,
} from "./lib/runner/player-input.js";
import type { PlayerInputSource } from "./lib/runner/player-input.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function promptPlayer(source: PlayerInputSource, prompt: string): Promise<string> {
  return source.prompt(prompt);
}

/**
 * Strip the MCP wrapper prefix `mcp__<server>__` from a tool name so
 * callers see e.g. "resolve_action" not "mcp__my-game__resolve_action".
 */
function stripMcpPrefix(rawName: string): string {
  const parts = rawName.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return rawName;
}

/**
 * Build a short hint for a tool-call indicator line. Picks the most
 * identifying field from common tool-arg shapes and truncates. Falls back
 * to `phase` / `action` (pausable tools) and `kind` / `type` (discriminated
 * unions) so indicator lines stay informative for control-flow-heavy tools.
 *
 * When multiple informative fields are present (e.g. a pausable tool call
 * with both `phase: "continue"` and `action: "hit"`), shows both separated
 * by a bullet.
 *
 * Returns "" if nothing short and human-readable can be extracted.
 */
function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pickStr = (k: string): string | null => {
    const v = i[k];
    return typeof v === "string" && v ? v : null;
  };
  // "Primary" fields that identify WHAT entity/action the tool is working on.
  const primary =
    pickStr("name") ??
    pickStr("description") ??
    pickStr("threat") ??
    pickStr("operation") ??
    null;
  // "Control" fields that identify HOW the tool call is operating. Shown
  // alongside primary when both are present (e.g. memory-book upserts +
  // name), or on their own for pausable / discriminated-union tools.
  const control = pickStr("phase") ?? pickStr("action") ?? pickStr("kind") ?? pickStr("type") ?? null;

  const parts: string[] = [];
  if (primary) parts.push(primary);
  if (control) parts.push(control);
  if (parts.length === 0) return "";

  const max = 60;
  const joined = parts.join(" · ");
  const truncated = joined.length > max ? joined.slice(0, max) + "…" : joined;
  return ` ${JSON.stringify(truncated)}`;
}

/**
 * Stream one query turn, printing assistant text to stdout and mirroring
 * facilitator text + tool-call indicators + tool-result payloads to the
 * transcript writer. Returns the session_id from the result message.
 *
 * Tool results arrive in user-role messages keyed by tool_use_id. We maintain
 * a small id → name map across the turn so result lines can be labelled with
 * the tool they came back from (e.g. "roll_action → {outcome_tier: ...}").
 */
async function streamTurn(
  queryIter: AsyncIterable<Record<string, unknown>>,
  transcript: TranscriptWriter
): Promise<{ sessionId: string; facilitatorText: string }> {
  let sessionId = "";
  let facilitatorText = "";
  const toolUseNames = new Map<string, string>();

  for await (const message of queryIter) {
    if (!("type" in message)) continue;

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<Record<string, unknown>> };
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(block.text);
          transcript.recordFacilitatorChunk(block.text);
          facilitatorText += block.text;
        } else if (block.type === "tool_use") {
          // Dim line showing the tool call so the player (and you,
          // debugging) can see the memory books and game tools firing
          // under the narration.
          const name = stripMcpPrefix(typeof block.name === "string" ? block.name : "");
          const hint = summariseToolInput(block.input);
          const id = typeof block.id === "string" ? block.id : "";
          if (id) toolUseNames.set(id, name);
          process.stdout.write(`\n\x1b[2m  ↪ ${name}${hint}\x1b[0m\n`);
          transcript.recordToolCall(name, hint);
        }
      }
    } else if (message.type === "user" && "message" in message) {
      // Tool results arrive in user-role messages as tool_result blocks.
      // Don't print to stdout (would spam the game view); mirror to transcript.
      const msg = message.message as { content: Array<Record<string, unknown>> };
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const name = toolUseNames.get(id) ?? "unknown_tool";
          const resultText = extractToolResultText(block);
          transcript.recordToolResult(name, resultText);
        }
      }
    } else if (message.type === "result") {
      const result = message as { session_id?: string; subtype?: string };
      sessionId = result.session_id ?? "";
      if (result.subtype !== "success") {
        console.error(`\n[Facilitator agent ended with: ${result.subtype}]`);
      }
    }
  }

  // Ensure terminal output ends with newline; flush transcript turn too
  process.stdout.write("\n");
  transcript.endFacilitatorTurn(sessionId);
  return { sessionId, facilitatorText };
}

/**
 * Extract the text payload from a tool_result block. MCP tool_results can
 * carry their content as an array of content blocks (typical) or a raw string.
 */
function extractToolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        c &&
        typeof c === "object" &&
        (c as Record<string, unknown>).type === "text" &&
        typeof (c as Record<string, unknown>).text === "string"
      ) {
        return (c as Record<string, unknown>).text as string;
      }
    }
  } else if (typeof content === "string") {
    return content;
  }
  return "";
}

// ── Save / resume helpers ──────────────────────────────────────────────

function readSavedSessionId(stateDir: string): string | undefined {
  const p = path.join(stateDir, "session-id.txt");
  if (!fs.existsSync(p)) return undefined;
  try {
    const id = fs.readFileSync(p, "utf-8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function writeSessionId(stateDir: string, id: string): void {
  if (!id) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "session-id.txt"), id, "utf-8");
}

/** Delete every file directly in stateDir (preserves the dir itself). */
function clearAllState(stateDir: string): string[] {
  if (!fs.existsSync(stateDir)) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(stateDir)) {
    const p = path.join(stateDir, entry);
    try {
      if (fs.statSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(entry);
      }
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Delete just the session-id pointer; preserves scratchpad, books, etc.
 *  Returns true if a session-id file existed and was removed. */
function clearSessionId(stateDir: string): boolean {
  const p = path.join(stateDir, "session-id.txt");
  if (!fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce a ≤500-char premise/tone snippet for the bookkeeper's context.
 * Prefers `config.description` (already crisp, set by the characterizer);
 * falls back to a truncated head of the lore summary JSON.
 */
function buildShortLoreSummary(
  config: { description?: string; name?: string },
  loreSummary: string | undefined
): string {
  const desc = typeof config.description === "string" ? config.description.trim() : "";
  if (desc) return desc.length > 500 ? desc.slice(0, 500) + "…" : desc;
  if (!loreSummary) return "";
  const stripped = loreSummary.replace(/\s+/g, " ").trim();
  return stripped.length > 500 ? stripped.slice(0, 500) + "…" : stripped;
}

async function confirmPrompt(
  source: PlayerInputSource,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await promptPlayer(source, `${question} ${suffix} `))
    .trim()
    .toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function main() {
  // Load runner config
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      "No config.json found. Are you running this from a runner directory?"
    );
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Parse seed-mode flags early. These monkey-patch Math.random process-
  // wide so tool primitives become deterministic. Must happen BEFORE the
  // game server is constructed, in case a tool factory uses RNG at setup.
  const argvRaw = process.argv.slice(2);
  const seedArg = argvRaw.find((a) => a.startsWith("--seed="));
  const sequenceArg = argvRaw.find((a) => a.startsWith("--rng-sequence="));
  if (seedArg && sequenceArg) {
    console.error(
      "Error: --seed and --rng-sequence are mutually exclusive."
    );
    process.exit(1);
  }
  let seedModeLabel: string | undefined;
  if (seedArg) {
    const raw = seedArg.slice("--seed=".length).trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      console.error(
        `Error: --seed requires an integer value, got: ${raw || "<empty>"}`
      );
      process.exit(1);
    }
    installSeededRng(n);
    seedModeLabel = `seed=${n}`;
    console.log(`[seed mode: ${seedModeLabel} — Math.random is deterministic]`);
  } else if (sequenceArg) {
    const raw = sequenceArg.slice("--rng-sequence=".length);
    try {
      const values = parseSequenceArg(raw);
      installSequenceRng(values);
      seedModeLabel = `scripted (${values.length} values)`;
      console.log(
        `[seed mode: ${seedModeLabel} — Math.random cycles through the given values]`
      );
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Dynamically import the game server. With seed mode installed above,
  // any RNG this server touches during construction is already patched.
  const serverModule = await import("./tools/server.js");
  const gameServer = serverModule.createGameServer();

  // Create facilitator memory server (scratchpad + typed books for NPCs, factions, character sheets)
  const stateDir = path.join(__dirname, "state");
  const facilitatorServer = createSdkMcpServer({
    name: "facilitator",
    version: "1.0.0",
    tools: createFacilitatorMemoryTools(stateDir),
  });

  // Load lore summary
  const lorePath = path.join(__dirname, "lore", "summary.json");
  let loreSummary: string | undefined;
  if (fs.existsSync(lorePath)) {
    const lore = JSON.parse(fs.readFileSync(lorePath, "utf-8"));
    loreSummary = JSON.stringify(lore, null, 2);
  }

  // Build the full facilitator system prompt
  const { facilitatorPrompt, characterCreation, shipCreation } = config;
  const additionalCreation: Record<string, unknown> = {};
  if (shipCreation) additionalCreation.shipCreation = shipCreation;

  const systemPrompt = buildFacilitatorSystemPrompt({
    gamePrompt: facilitatorPrompt,
    gameName: config.name,
    loreSummary,
    characterCreation,
    additionalCreation:
      Object.keys(additionalCreation).length > 0
        ? additionalCreation
        : undefined,
  });

  // Parse session-mode launch flags (seed-mode flags were parsed earlier).
  const forceNew = argvRaw.includes("--new");
  const forceNewSession = argvRaw.includes("--new-session");
  const forceResume = argvRaw.includes("--resume");
  const modeCount = [forceNew, forceNewSession, forceResume].filter(Boolean).length;
  if (modeCount > 1) {
    console.error(
      "Error: --new, --new-session, and --resume are mutually exclusive."
    );
    process.exit(1);
  }

  // Display header
  console.log(`\n${config.name}`);
  console.log(`${config.description}`);
  console.log(`Source: ${config.source} (${config.license})`);
  console.log(
    `\nType /quit to exit, /new to wipe all state, /new-session for a fresh session (keeps world).\n`
  );

  // Player input source — stdin by default; --player-script=FILE swaps in
  // a pre-recorded NDJSON script; --player-script-tail=FILE tails the file
  // for appended lines so an external driver can feed turns live.
  const scriptArg = argvRaw.find((a) => a.startsWith("--player-script="));
  const scriptTailArg = argvRaw.find((a) =>
    a.startsWith("--player-script-tail=")
  );
  if (scriptArg && scriptTailArg) {
    console.error(
      "Specify only one of --player-script=FILE or --player-script-tail=FILE."
    );
    process.exit(1);
  }
  const rl = scriptArg || scriptTailArg ? null : createReadline();
  const playerSource: PlayerInputSource = scriptArg
    ? createScriptSource(scriptArg.slice("--player-script=".length).trim())
    : scriptTailArg
    ? createScriptTailSource(
        scriptTailArg.slice("--player-script-tail=".length).trim()
      )
    : createStdinSource(rl!);
  if (scriptArg) {
    console.log(
      `[player source: script — reading input from ${scriptArg.slice("--player-script=".length).trim()}]\n`
    );
  } else if (scriptTailArg) {
    console.log(
      `[player source: script-tail — tailing ${scriptTailArg.slice("--player-script-tail=".length).trim()} for appended turns]\n`
    );
  }

  const sharedOptions = {
    systemPrompt,
    mcpServers: {
      [gameServer.name]: gameServer,
      facilitator: facilitatorServer,
    },
    model: "sonnet",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    tools: [] as string[],
  };

  // Transcript logger — per-session markdown file under state/transcripts/.
  const transcript = createTranscriptWriter(stateDir);

  // Subagent trace — per-session JSONL next to the markdown transcript.
  const subagentTrace = createSubagentTrace(stateDir);

  // Short premise/tone summary we thread into the bookkeeper's context.
  // The bookkeeper runs on Haiku with a fresh context; it doesn't need full
  // lore, just enough to recognise setting-appropriate entity types.
  const loreSummaryShort = buildShortLoreSummary(config, loreSummary);

  // Facilitator-role key used in the bookkeeper's context. Plan: future
  // config.json schemas may surface this explicitly per-game; for now we
  // fall back to a neutral default.
  const facilitatorRole: string =
    (config.facilitatorRole as string | undefined) ?? "facilitator";

  // Turn counter for bookkeeper trace correlation. Incremented before
  // each streamTurn call.
  let turnNumber = 0;

  // Fire-and-track pending bookkeeper invocation. Awaited before the next
  // facilitator turn (so the books reflect turn N before turn N+1 reads
  // them) and on /quit / /new / /new-session (so writes land before
  // we wipe state or exit).
  let pendingBookkeeper: Promise<void> | null = null;

  function enqueueBookkeeper(input: {
    turnText: string;
    turn: number;
    sessionId: string;
  }): void {
    if (!input.turnText.trim() || !input.sessionId) return;
    pendingBookkeeper = runBookkeeper(
      {
        turnText: input.turnText,
        turn: input.turn,
        sessionId: input.sessionId,
        gameContext: {
          gameName: config.name,
          facilitatorRole,
          loreSummaryShort,
        },
      },
      facilitatorServer,
      subagentTrace
    )
      .then((result) => {
        transcript.recordSubagentSummary(
          "bookkeeper",
          result.toolCalls,
          result.summary
        );
      })
      .catch((err) => {
        console.error(`\n[bookkeeper] ${(err as Error).message ?? err}`);
      });
  }

  async function awaitPendingBookkeeper(): Promise<void> {
    if (pendingBookkeeper) {
      await pendingBookkeeper;
      pendingBookkeeper = null;
    }
  }

  // Three distinct first-turn prompts for different entry paths.
  const initialPrompt = `The player has just started a new game of ${config.name}. Greet them and begin the session zero flow as described in your instructions.`;
  const resumePrompt = `The player has returned to the game after closing the terminal. Follow your sitting-management protocol: read your scratchpad and \`list\` your npcs/factions/character_sheets books to reorient, then recap briefly (a sentence or two on where we left off) and ask what they want to do next. Don't dump the full memory state — just orient.`;
  const freshSessionPrompt = `The player has started a fresh session. Read your scratchpad and \`list\` your npcs/factions/character_sheets books to see what world state already exists. If there are existing PC(s), NPCs, or factions, greet the player warmly, briefly describe what you remember, and ask whether they're continuing with an existing PC, introducing a new PC in this world, or starting something else. If the books are empty, this is a true first session — run the session zero greeting flow.`;

  // Decide the first-turn mode.
  const savedId = readSavedSessionId(stateDir);
  type FirstMode = "resume" | "fresh-session" | "initial";
  let firstMode: FirstMode;
  let resumeId: string | undefined;

  if (forceNew) {
    const removed = clearAllState(stateDir);
    console.log(
      `[--new: ${removed.length > 0 ? `wiped ${removed.join(", ")}` : "no state to wipe"}]\n`
    );
    firstMode = "initial";
    resumeId = undefined;
  } else if (forceNewSession) {
    if (clearSessionId(stateDir)) {
      console.log("[--new-session: cleared session-id; world state preserved]\n");
    } else {
      console.log("[--new-session: no prior session; world state preserved]\n");
    }
    firstMode = "fresh-session";
    resumeId = undefined;
  } else if (forceResume) {
    if (savedId) {
      firstMode = "resume";
      resumeId = savedId;
    } else {
      console.log("[--resume: no saved session found; starting fresh]\n");
      firstMode = "initial";
      resumeId = undefined;
    }
  } else if (savedId) {
    const wantResume = await confirmPrompt(playerSource, "Saved session found. Resume?", true);
    console.log("");
    if (wantResume) {
      firstMode = "resume";
      resumeId = savedId;
    } else {
      // Declined resume — keep world state, start a fresh Claude session.
      clearSessionId(stateDir);
      firstMode = "fresh-session";
      resumeId = undefined;
    }
  } else {
    firstMode = "initial";
    resumeId = undefined;
  }

  // First turn
  const firstPrompt =
    firstMode === "resume"
      ? resumePrompt
      : firstMode === "fresh-session"
        ? freshSessionPrompt
        : initialPrompt;
  if (resumeId) {
    console.log(`[Resuming session ${resumeId.slice(0, 8)}…]\n`);
  }
  transcript.beginSession({ gameName: config.name, mode: firstMode, seedLabel: seedModeLabel });
  turnNumber += 1;
  const firstResult = await streamTurn(
    query({
      prompt: firstPrompt,
      options: resumeId ? { ...sharedOptions, resume: resumeId } : sharedOptions,
    }),
    transcript
  );
  let sessionId = firstResult.sessionId;
  writeSessionId(stateDir, sessionId);
  enqueueBookkeeper({
    turnText: firstResult.facilitatorText,
    turn: turnNumber,
    sessionId,
  });

  // Play loop
  while (true) {
    const input = await promptPlayer(playerSource, "\n> ");
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/quit") {
      // Let pending bookkeeper writes land before we exit.
      await awaitPendingBookkeeper();
      console.log("\n[Thanks for playing!]");
      break;
    }

    if (lower === "/new") {
      const confirmed = await confirmPrompt(
        playerSource,
        "This will wipe ALL state (scratchpad, character sheets, NPCs, factions) and start a new campaign. Continue?",
        false
      );
      if (!confirmed) {
        console.log("[Cancelled.]");
        continue;
      }
      // Flush in-flight writes before wiping state so we don't race the
      // bookkeeper writing into files we're about to delete.
      await awaitPendingBookkeeper();
      const removed = clearAllState(stateDir);
      console.log(
        `\n[Wiped: ${removed.length > 0 ? removed.join(", ") : "nothing to wipe"}]\n`
      );
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "initial", seedLabel: seedModeLabel });
      turnNumber = 1;
      const res = await streamTurn(
        query({
          prompt: initialPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      sessionId = res.sessionId;
      writeSessionId(stateDir, sessionId);
      enqueueBookkeeper({
        turnText: res.facilitatorText,
        turn: turnNumber,
        sessionId,
      });
      continue;
    }

    if (lower === "/new-session") {
      await awaitPendingBookkeeper();
      clearSessionId(stateDir);
      console.log("\n[Cleared session-id; world state preserved.]\n");
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "fresh-session", seedLabel: seedModeLabel });
      turnNumber += 1;
      const res = await streamTurn(
        query({
          prompt: freshSessionPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      sessionId = res.sessionId;
      writeSessionId(stateDir, sessionId);
      enqueueBookkeeper({
        turnText: res.facilitatorText,
        turn: turnNumber,
        sessionId,
      });
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    console.log("");

    // Before the facilitator starts reading books for turn N+1, make sure
    // turn N's bookkeeper has finished writing to them.
    await awaitPendingBookkeeper();

    transcript.recordPlayerInput(input);
    turnNumber += 1;
    const res = await streamTurn(
      query({
        prompt: input,
        options: {
          ...sharedOptions,
          resume: sessionId,
        },
      }),
      transcript
    );
    sessionId = res.sessionId;
    writeSessionId(stateDir, sessionId);
    enqueueBookkeeper({
      turnText: `> ${input}\n\n${res.facilitatorText}`,
      turn: turnNumber,
      sessionId,
    });
  }

  await playerSource.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
