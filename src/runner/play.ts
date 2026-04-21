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
 * Build a short hint for a tool-call indicator line. Picks the most identifying
 * field from common shapes (name / description / operation / threat) and
 * truncates. Returns "" if nothing fits.
 */
function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick = (k: string): string | null => {
    const v = i[k];
    return typeof v === "string" && v ? v : null;
  };
  const headline =
    pick("name") ?? pick("description") ?? pick("operation") ?? pick("threat") ?? "";
  if (!headline) return "";
  const max = 60;
  const truncated = headline.length > max ? headline.slice(0, max) + "…" : headline;
  return ` ${JSON.stringify(truncated)}`;
}

/**
 * Stream one query turn, printing assistant text to stdout.
 * Returns the session_id from the result message.
 */
async function streamTurn(
  queryIter: AsyncIterable<Record<string, unknown>>
): Promise<string> {
  let sessionId = "";

  for await (const message of queryIter) {
    if (!("type" in message)) continue;

    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<Record<string, unknown>> };
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          // Dim line showing the tool call so the player (and you,
          // debugging) can see the memory books and game tools firing
          // under the narration.
          const name = stripMcpPrefix(typeof block.name === "string" ? block.name : "");
          const hint = summariseToolInput(block.input);
          process.stdout.write(`\n\x1b[2m  ↪ ${name}${hint}\x1b[0m\n`);
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

  // Ensure output ends with newline
  process.stdout.write("\n");
  return sessionId;
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
  let sessionId = await streamTurn(
    query({
      prompt: firstPrompt,
      options: resumeId ? { ...sharedOptions, resume: resumeId } : sharedOptions,
    })
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
      sessionId = await streamTurn(
        query({
          prompt: initialPrompt,
          options: sharedOptions,
        })
      );
      writeSessionId(stateDir, sessionId);
      continue;
    }

    if (lower === "/new-session") {
      clearSessionId(stateDir);
      console.log("\n[Cleared session-id; world state preserved.]\n");
      sessionId = await streamTurn(
        query({
          prompt: freshSessionPrompt,
          options: sharedOptions,
        })
      );
      writeSessionId(stateDir, sessionId);
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    console.log("");

    sessionId = await streamTurn(
      query({
        prompt: input,
        options: {
          ...sharedOptions,
          resume: sessionId,
        },
      })
    );
    writeSessionId(stateDir, sessionId);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
