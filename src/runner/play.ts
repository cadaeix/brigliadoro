/**
 * Generic play harness for Brigliadoro runners.
 *
 * This file is copied into each generated runner at build time.
 * It reads config.json, loads the game's MCP server, builds the
 * GM system prompt, and runs an interactive terminal play loop.
 *
 * Usage: npx tsx play.ts
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buildGMSystemPrompt } from "./lib/runner/gm-prompt-template.js";
import { createGMMemoryTools } from "./lib/runner/gm-memory.js";

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
      const msg = message.message as { content: Array<{ type: string; text?: string }> };
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        }
      }
    } else if (message.type === "result") {
      const result = message as { session_id?: string; subtype?: string };
      sessionId = result.session_id ?? "";
      if (result.subtype !== "success") {
        console.error(`\n[GM agent ended with: ${result.subtype}]`);
      }
    }
  }

  // Ensure output ends with newline
  process.stdout.write("\n");
  return sessionId;
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

  // Create GM memory server (scratchpad + typed books for NPCs, factions, character sheets)
  const stateDir = path.join(__dirname, "state");
  const gmToolsServer = createSdkMcpServer({
    name: "gm-tools",
    version: "1.0.0",
    tools: createGMMemoryTools(stateDir),
  });

  // Load lore summary
  const lorePath = path.join(__dirname, "lore", "summary.json");
  let loreSummary: string | undefined;
  if (fs.existsSync(lorePath)) {
    const lore = JSON.parse(fs.readFileSync(lorePath, "utf-8"));
    loreSummary = JSON.stringify(lore, null, 2);
  }

  // Build the full GM system prompt
  const { gmPrompt, characterCreation, shipCreation, ...rest } = config;
  const additionalCreation: Record<string, unknown> = {};
  if (shipCreation) additionalCreation.shipCreation = shipCreation;

  const systemPrompt = buildGMSystemPrompt({
    gamePrompt: gmPrompt,
    gameName: config.name,
    loreSummary,
    characterCreation,
    additionalCreation:
      Object.keys(additionalCreation).length > 0
        ? additionalCreation
        : undefined,
  });

  // Display header
  console.log(`\n${config.name}`);
  console.log(`${config.description}`);
  console.log(`Source: ${config.source} (${config.license})`);
  console.log(`\nType /quit to exit.\n`);

  const rl = createReadline();

  const sharedOptions = {
    systemPrompt,
    mcpServers: {
      [gameServer.name]: gameServer,
      "gm-tools": gmToolsServer,
    },
    model: "sonnet",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    tools: [] as string[],
  };

  // First turn — GM introduces itself
  const initialPrompt = `The player has just started a new game of ${config.name}. Greet them and begin the session zero flow as described in your instructions.`;

  let sessionId = await streamTurn(
    query({
      prompt: initialPrompt,
      options: sharedOptions,
    })
  );

  // Play loop
  while (true) {
    const input = await promptPlayer(rl, "\n> ");

    if (input.trim().toLowerCase() === "/quit") {
      console.log("\n[Thanks for playing!]");
      break;
    }

    if (input.trim() === "") {
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
  }

  rl.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
