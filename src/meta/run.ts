import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ORCHESTRATOR_PROMPT } from "./prompts/orchestrator.js";
import { TOOL_BUILDER_PROMPT } from "./prompts/tool-builder.js";
import { CHARACTERIZER_PROMPT } from "./prompts/characterizer.js";
import { VALIDATOR_PROMPT } from "./prompts/validator.js";

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

// Prompts are now in separate files under src/meta/prompts/

type AgentModel = "sonnet" | "opus" | "haiku";

/**
 * Model assignments for each agent in the generation pipeline.
 * Tune these to balance quality vs. cost/speed.
 *
 * Rationale from CLAUDE.md:
 * - Opus: decisions requiring taste and narrative judgment
 * - Sonnet: bulk code generation
 * - Haiku: cheap repetitive parsing/validation
 */
interface ModelConfig {
  /** Orchestrator: reads sourcebook, coordinates subagents. Benefits from judgment. */
  orchestrator: AgentModel;
  /** Tool Builder: writes mechanical TypeScript code. Sonnet's sweet spot. */
  toolBuilder: AgentModel;
  /** Characterizer: captures tone, narrative identity, role framing, play experience. Benefits from taste. */
  characterizer: AgentModel;
  /** Validator: writes tests, runs them, fixes failures. Mechanical work. */
  validator: AgentModel;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  /** All Sonnet — cheapest, good baseline. */
  default: {
    orchestrator: "sonnet",
    toolBuilder: "sonnet",
    characterizer: "sonnet",
    validator: "sonnet",
  },
  /** Opus for judgment calls, Sonnet for code, Haiku for validation. */
  quality: {
    orchestrator: "opus",
    toolBuilder: "sonnet",
    characterizer: "opus",
    validator: "haiku",
  },
};

async function main() {
  const args = process.argv.slice(2);

  // Parse --models flag (e.g., --models quality)
  let modelPreset = "default";
  const modelsIdx = args.indexOf("--models");
  if (modelsIdx !== -1) {
    modelPreset = args[modelsIdx + 1] ?? "default";
    args.splice(modelsIdx, 2);
  }

  if (args.length < 2) {
    console.error("Usage: npx tsx src/meta/run.ts <sourcebook-path> <runner-name> [--models default|quality]");
    console.error("Example: npx tsx src/meta/run.ts 'test ttrpgs/one page rpgs/lasers_and_feelings_rpg.pdf' lasers-and-feelings");
    process.exit(1);
  }

  const models = MODEL_CONFIGS[modelPreset];
  if (!models) {
    console.error(`Unknown model preset: ${modelPreset}. Available: ${Object.keys(MODEL_CONFIGS).join(", ")}`);
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
  fs.mkdirSync(path.join(runnerDir, "evals"), { recursive: true });
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
  console.log(`   Output: ${runnerDir}`);
  console.log(`   Models: ${modelPreset} (orchestrator=${models.orchestrator}, tools=${models.toolBuilder}, characterizer=${models.characterizer}, validator=${models.validator})\n`);

  const prompt = `Read the TTRPG sourcebook at "${sourcebookPath}" and generate a complete runner in the directory "${runnerDir}".

The runner needs:
1. Game-specific MCP tools in ${runnerDir}/tools/ (delegate to tool-builder)
2. A config.json with facilitatorPrompt, lore, and character creation (delegate to characterizer)
3. Tests in ${runnerDir}/tests/ that pass (delegate to validator)

Do NOT create play.ts, package.json, lib/, or state/ — these are already set up by the runner harness.

Follow your orchestration protocol: read the sourcebook, analyze it, then delegate to your subagents in the correct sequence.`;

  let lastResult = "";
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: ORCHESTRATOR_PROMPT,
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
      ],
      permissionMode: "bypassPermissions",
      model: models.orchestrator,
      agents: {
        "tool-builder": {
          description:
            "Build MCP game tools implementing the TTRPG's mechanical resolution. Creates tool files and server.ts in the runner's tools/ directory.",
          tools: ["Read", "Write", "Edit", "Glob", "Grep"],
          prompt: TOOL_BUILDER_PROMPT,
          model: models.toolBuilder,
        },
        "characterizer": {
          description:
            "Classify the game's facilitator style, then write the facilitator prompt, character creation config, lore summary, and config.json. Use after tools are built, passing tool names and descriptions.",
          tools: ["Read", "Write", "Edit", "Glob", "Grep"],
          prompt: CHARACTERIZER_PROMPT,
          model: models.characterizer,
        },
        "validator": {
          description:
            "Write vitest tests for game tools, run them, and fix test failures. Use after tools are built. Reports tool code bugs back instead of fixing them.",
          tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          prompt: VALIDATOR_PROMPT,
          model: models.validator,
        },
      },
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
