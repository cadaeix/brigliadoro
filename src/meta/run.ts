import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { PRIMITIVES_API_REFERENCE } from "./primitives-api.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Recursively copy a directory.
 * @param skipPrefixes — skip entries at THIS level whose name starts with any of these
 * @param skipFiles — skip files (at any level) whose name starts with any of these
 */
function copyDirRecursive(
  src: string,
  dest: string,
  skipPrefixes: string[] = [],
  skipFiles: string[] = []
): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipPrefixes.some((p) => entry.name.startsWith(p))) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, [], skipFiles);
    } else {
      if (skipFiles.some((p) => entry.name.startsWith(p))) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const SYSTEM_PROMPT = `You are the Meta-TTRPGinator, part of the Brigliadoro system. Your job is to read a TTRPG sourcebook and generate a complete, working runner — a set of MCP game tools, tests, lore files, and configuration that a GM Claude agent will use to run the game.

## Your Process

1. READ the sourcebook thoroughly. Identify:
   - Core resolution mechanic(s) — how dice/cards/resources determine outcomes
   - Character creation rules — stats, attributes, skills, special abilities
   - Specific moves, actions, or abilities that have mechanical triggers
   - Setting/lore essentials — tone, world, factions, key concepts
   - GM guidance — how the GM should run the game, pacing advice, principles

2. DESIGN game tools. Each distinct mechanical action becomes its own MCP tool:
   - Each tool wraps one or more foundation primitives (rollDice, drawFromPool, etc.)
   - Each tool has a clear narrative trigger condition in its description (so GM Claude picks it by fiction, not by mechanics)
   - Each tool handles the full mechanical resolution internally and returns an interpreted, narrative-ready result
   - **Tool results must be self-interpreting.** The tool output should include the outcome tier AND its narrative guidance (e.g. "Partial success — you get what you want, but at a price"). GM Claude should be able to narrate directly from the tool result without consulting any other reference.
   - GM Claude should NEVER need to do math, remember mechanical rules, or look up result interpretation tables — tools do ALL of that

3. GENERATE the runner files in the output directory:

   a. \`tools/\` — TypeScript files, one per game tool (or grouped logically)
      - Each exports a factory function: \`createXxxTool()\` or \`createXxxTool(store: SessionStore)\`
      - Use the foundation primitives, never raw Math.random
      - Return structured JSON results that GM Claude can narrate from

   b. \`tools/server.ts\` — assembles all game tools into one MCP server:
      \`\`\`typescript
      import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
      import { SessionStore } from "../lib/state/session-store.js";
      // import game tools...

      export function createGameServer() {
        const store = new SessionStore();
        return createSdkMcpServer({
          name: "game-name",
          version: "1.0.0",
          tools: [/* all game tools */],
        });
      }
      \`\`\`

   c. \`tests/\` — vitest test files for the game tools
      - Test the mechanical logic with deterministic RNG
      - Cover: basic success, failure, edge cases, special triggers

   d. \`lore/\` — JSON files with setting information:
      - \`summary.json\` — concise overview (always loaded into GM Claude's context)
        Contains: title, tone, premise, player_role, key_concepts
      - Additional JSON files for deeper lore (greppable/globbable)

   e. \`config.json\` — runner configuration:
      \`\`\`json
      {
        "name": "Game Name",
        "version": "1.0.0",
        "source": "Source attribution",
        "license": "CC BY 4.0 or whatever applies",
        "description": "One-line description",
        "gmPrompt": "System prompt for GM Claude (personality, principles, how to use tools)",
        "characterCreation": {
          "steps": ["step 1 description", "step 2", ...],
          "choices": { "stat_name": ["option1", "option2", ...] }
        }
      }
      \`\`\`

4. The gmPrompt in config.json is the GAME-SPECIFIC part of the GM's instructions. The runner harness automatically wraps it with universal session lifecycle behavior (greeting, session zero, play loop, session end, scratchpad usage). So the gmPrompt should ONLY contain:
   - The game's tone, setting, and world
   - Which tools to use and when (by narrative trigger, not mechanical rule)
   - GM principles from the source material (e.g. "play to find out what happens")
   - Game-specific narration guidance (how to describe this world, NPC personality tips)
   - Do NOT include instructions about greeting the player, character creation flow, session management, or scratchpad usage — those are handled by the universal harness.
   - Do NOT duplicate mechanical interpretation in the GM prompt — tools are the single source of truth for how results are interpreted.

## Important Rules

- ALL imports from primitives/types/state use the runner's local lib folder: \`../lib/primitives/index.js\`, \`../lib/types/index.js\`, \`../lib/state/session-store.js\`
- ALL imports must use .js extensions (ESM project)
- Use \`import { z } from "zod";\` for schemas
- Use \`import { tool } from "@anthropic-ai/claude-agent-sdk";\` for tool definitions
- Game tools return \`{ content: [{ type: "text" as const, text: JSON.stringify(result) }] }\`
- Use \`isError: true\` for recoverable errors, never throw
- Use the SessionStore for any state that persists across tool calls (character stats, tracked resources, clocks)
- Tests must use the seededRng pattern for deterministic testing
- Use platform-neutral language in READMEs and docs — say "terminal" or "shell", not "bash". Use \`sh\` or \`shell\` as the code block language tag. The project runs on Windows, macOS, and Linux.

${PRIMITIVES_API_REFERENCE}
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx src/meta/run.ts <sourcebook-path> <runner-name>");
    console.error("Example: npx tsx src/meta/run.ts 'test ttrpgs/one page rpgs/lasers_and_feelings_rpg.pdf' lasers-and-feelings");
    process.exit(1);
  }

  const sourcebookPath = path.resolve(args[0]!);
  const runnerName = args[1]!;
  const runnerDir = path.resolve("runners", runnerName);

  if (!fs.existsSync(sourcebookPath)) {
    console.error(`Sourcebook not found: ${sourcebookPath}`);
    process.exit(1);
  }

  // Create runner directory structure
  fs.mkdirSync(path.join(runnerDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(runnerDir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(runnerDir, "lore"), { recursive: true });
  fs.mkdirSync(path.join(runnerDir, "state"), { recursive: true });

  // Build brigliadoro first so dist/ is up to date
  console.log("Building brigliadoro...");
  execSync("npm run build", { cwd: path.resolve(__dirname, "../.."), stdio: "inherit" });

  // Copy compiled primitives, types, and state into runner's lib/
  const distDir = path.resolve(__dirname, "../../dist");
  const libDir = path.join(runnerDir, "lib");
  copyDirRecursive(distDir, libDir, ["meta", "tools", "index"], ["play."]);

  // Copy play.ts into the runner
  const playSource = path.resolve(__dirname, "../runner/play.ts");
  fs.copyFileSync(playSource, path.join(runnerDir, "play.ts"));

  // Generate runner package.json
  const runnerPackageJson = {
    name: runnerName,
    version: "1.0.0",
    type: "module",
    private: true,
    scripts: {
      play: "npx tsx play.ts",
      test: "npx vitest run tests/",
    },
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": "^0.1.0",
      zod: "^3.25.0",
    },
    devDependencies: {
      "@types/node": "^25.6.0",
      tsx: "^4.21.0",
      vitest: "^3.1.0",
    },
  };
  fs.writeFileSync(
    path.join(runnerDir, "package.json"),
    JSON.stringify(runnerPackageJson, null, 2) + "\n"
  );

  console.log(`\n🎲 Meta-TTRPGinator starting`);
  console.log(`   Source: ${sourcebookPath}`);
  console.log(`   Output: ${runnerDir}\n`);

  const prompt = `Read the TTRPG sourcebook at "${sourcebookPath}" and generate a complete runner in the directory "${runnerDir}".

Create all the necessary files:
1. Game-specific MCP tools in ${runnerDir}/tools/ that wrap the foundation primitives
2. A server.ts that assembles all tools
3. Tests in ${runnerDir}/tests/
4. Lore files in ${runnerDir}/lore/
5. A config.json with the GM prompt and character creation info

Do NOT create play.ts, package.json, lib/, or state/ — these are already set up by the runner harness.

After generating all files, run the tests with: npx vitest run ${runnerDir}/tests/

Make sure everything compiles and tests pass before finishing.`;

  let lastResult = "";
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
      ],
      permissionMode: "bypassPermissions",
      model: "sonnet",
    },
  })) {
    if ("type" in message) {
      if (message.type === "assistant" && "content" in message) {
        for (const block of message.content as Array<{ type: string; text?: string }>) {
          if (block.type === "text" && block.text) {
            process.stdout.write(block.text);
          }
        }
      } else if (message.type === "result") {
        const result = message as { type: string; subtype?: string; result?: string; session_id?: string };
        lastResult = result.result ?? "";
        console.log(`\n\n✅ Meta-TTRPGinator finished (${result.subtype})`);
        if (result.session_id) {
          console.log(`   Session: ${result.session_id}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("Meta-TTRPGinator failed:", err);
  process.exit(1);
});
