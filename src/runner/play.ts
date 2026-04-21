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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function promptPlayer(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Strip the MCP wrapper prefix `mcp__<server>__` from a tool name so
 * callers see e.g. "resolve_action" not "mcp__lasers-and-feelings__resolve_action".
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
): Promise<string> {
  let sessionId = "";
  const toolUseNames = new Map<string, string>();

  for await (const message of queryIter) {
    if (!("type" in message)) continue;

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<Record<string, unknown>> };
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(block.text);
          transcript.recordFacilitatorChunk(block.text);
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
  return sessionId;
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

async function confirmPrompt(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await promptPlayer(rl, `${question} ${suffix} `))
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

  // Dynamically import the game server
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

  // Parse launch flags
  const args = process.argv.slice(2);
  const forceNew = args.includes("--new");
  const forceNewSession = args.includes("--new-session");
  const forceResume = args.includes("--resume");
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

  const rl = createReadline();

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
    const wantResume = await confirmPrompt(rl, "Saved session found. Resume?", true);
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
  transcript.beginSession({ gameName: config.name, mode: firstMode });
  let sessionId = await streamTurn(
    query({
      prompt: firstPrompt,
      options: resumeId ? { ...sharedOptions, resume: resumeId } : sharedOptions,
    }),
    transcript
  );
  writeSessionId(stateDir, sessionId);

  // Play loop
  while (true) {
    const input = await promptPlayer(rl, "\n> ");
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/quit") {
      console.log("\n[Thanks for playing!]");
      break;
    }

    if (lower === "/new") {
      const confirmed = await confirmPrompt(
        rl,
        "This will wipe ALL state (scratchpad, character sheets, NPCs, factions) and start a new campaign. Continue?",
        false
      );
      if (!confirmed) {
        console.log("[Cancelled.]");
        continue;
      }
      const removed = clearAllState(stateDir);
      console.log(
        `\n[Wiped: ${removed.length > 0 ? removed.join(", ") : "nothing to wipe"}]\n`
      );
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "initial" });
      sessionId = await streamTurn(
        query({
          prompt: initialPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      writeSessionId(stateDir, sessionId);
      continue;
    }

    if (lower === "/new-session") {
      clearSessionId(stateDir);
      console.log("\n[Cleared session-id; world state preserved.]\n");
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "fresh-session" });
      sessionId = await streamTurn(
        query({
          prompt: freshSessionPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      writeSessionId(stateDir, sessionId);
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    console.log("");

    transcript.recordPlayerInput(input);
    sessionId = await streamTurn(
      query({
        prompt: input,
        options: {
          ...sharedOptions,
          resume: sessionId,
        },
      }),
      transcript
    );
    writeSessionId(stateDir, sessionId);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
