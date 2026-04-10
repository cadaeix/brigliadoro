import { query } from "@anthropic-ai/claude-agent-sdk";
import { PRIMITIVES_API_REFERENCE } from "./primitives-api.js";
import * as path from "node:path";
import * as fs from "node:fs";

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
   - GM Claude should NEVER need to do math or remember mechanical rules — tools do all of that

3. GENERATE the runner files in the output directory:

   a. \`tools/\` — TypeScript files, one per game tool (or grouped logically)
      - Each exports a factory function: \`createXxxTool()\` or \`createXxxTool(store: SessionStore)\`
      - Use the foundation primitives, never raw Math.random
      - Return structured JSON results that GM Claude can narrate from

   b. \`tools/server.ts\` — assembles all game tools into one MCP server:
      \`\`\`typescript
      import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
      import { SessionStore } from "../../src/state/session-store.js";
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

4. The gmPrompt in config.json is CRITICAL. It should:
   - Tell GM Claude the game's tone and setting
   - List which tools to use and when (by narrative trigger, not mechanical rule)
   - Include GM principles from the source material
   - Instruct GM Claude to describe outcomes narratively, not mechanically
   - Tell GM Claude to use AskUserQuestion for player choices

## Important Rules

- ALL imports from the brigliadoro src use relative paths like \`../../src/primitives/index.js\`
- ALL imports must use .js extensions (ESM project)
- Use \`import { z } from "zod";\` for schemas
- Use \`import { tool } from "@anthropic-ai/claude-agent-sdk";\` for tool definitions
- Game tools return \`{ content: [{ type: "text" as const, text: JSON.stringify(result) }] }\`
- Use \`isError: true\` for recoverable errors, never throw
- Use the SessionStore for any state that persists across tool calls (character stats, tracked resources, clocks)
- Tests must use the seededRng pattern for deterministic testing

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
