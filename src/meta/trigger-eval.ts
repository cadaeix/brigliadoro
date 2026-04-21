/**
 * Trigger-rate eval harness.
 *
 * Measures whether a generated runner's tool descriptions successfully steer
 * the facilitator agent to invoke tools at the right times. For each tool in the
 * runner, loads its `evals/<name>.triggers.json` corpus, runs each prompt
 * through a one-shot Claude query that has access to the game's MCP server
 * (and only that), captures which tools — if any — were invoked, and reports
 * pass rates per should-trigger bucket.
 *
 * Usage:
 *   npx tsx src/meta/trigger-eval.ts <runner-dir> [--model sonnet|opus|haiku] [--runs N]
 *
 * Output: per-tool and overall pass rates, plus a list of failing cases.
 * Non-zero exit code if any bucket falls below its threshold (positives
 * ≥0.8, negatives ≥0.9 pass rate).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

interface TriggerCase {
  prompt: string;
  should_trigger: boolean;
  note?: string;
  /** Optional: name of the tool that should fire. If omitted, any tool call counts as a trigger. */
  expected_tool?: string;
}

interface CaseResult {
  prompt: string;
  shouldTrigger: boolean;
  expectedTool?: string;
  toolsCalled: string[];
  passed: boolean;
  note?: string;
}

interface ToolReport {
  toolFile: string;
  cases: CaseResult[];
}

type AgentModel = "sonnet" | "opus" | "haiku";

const POSITIVE_THRESHOLD = 0.8;
const NEGATIVE_THRESHOLD = 0.9;

function parseArgs(argv: string[]): { runnerDir: string; model: AgentModel; runs: number } {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx tsx src/meta/trigger-eval.ts <runner-dir> [--model sonnet|opus|haiku] [--runs N]"
    );
    process.exit(1);
  }
  let model: AgentModel = "sonnet";
  let runs = 1;
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1) {
    const v = args[modelIdx + 1];
    if (v !== "sonnet" && v !== "opus" && v !== "haiku") {
      console.error(`Invalid --model: ${v}`);
      process.exit(1);
    }
    model = v;
    args.splice(modelIdx, 2);
  }
  const runsIdx = args.indexOf("--runs");
  if (runsIdx !== -1) {
    runs = Math.max(1, parseInt(args[runsIdx + 1] ?? "1", 10));
    args.splice(runsIdx, 2);
  }
  const runnerDir = path.resolve(args[0]!);
  if (!fs.existsSync(runnerDir)) {
    console.error(`Runner directory not found: ${runnerDir}`);
    process.exit(1);
  }
  return { runnerDir, model, runs };
}

async function loadGameServer(runnerDir: string): Promise<{ name: string; instance: unknown }> {
  const serverPath = path.join(runnerDir, "tools", "server.js");
  const serverTsPath = path.join(runnerDir, "tools", "server.ts");
  if (!fs.existsSync(serverPath) && !fs.existsSync(serverTsPath)) {
    throw new Error(`No tools/server.{ts,js} in runner: ${runnerDir}`);
  }
  // tsx handles .ts resolution when we import the .js specifier.
  const specifier = "file:///" + serverPath.replace(/\\/g, "/");
  const mod = (await import(specifier)) as { createGameServer?: () => { name: string } };
  if (!mod.createGameServer) {
    throw new Error(`tools/server.{ts,js} must export createGameServer()`);
  }
  const instance = mod.createGameServer();
  return { name: (instance as { name: string }).name, instance };
}

function minimalSystemPrompt(gameName: string): string {
  return [
    `You are the facilitator for ${gameName}, playing with a single human. This is a trigger-rate eval — the game-specific prompt and the universal template are not loaded; your only job is to decide, based on the tool descriptions below and the player's message, whether to invoke a game tool or respond narratively.`,
    `The player has just sent you a message. Decide what to do:`,
    ``,
    `- If their action calls for a mechanical resolution, invoke the appropriate game tool exactly once.`,
    `- If it's narrative chitchat, preparation, or a non-mechanical moment, respond briefly without invoking any tool.`,
    ``,
    `Keep your response concise — a sentence or two of narration is plenty.`,
    `Do not invoke more than one tool per message. Do not ask clarifying questions.`,
  ].join("\n");
}

async function runOneCase(
  prompt: string,
  gameServerName: string,
  gameServerInstance: unknown,
  systemPrompt: string,
  model: AgentModel
): Promise<string[]> {
  const mcpPrefix = `mcp__${gameServerName}__`;
  const called: string[] = [];

  for await (const message of query({
    prompt,
    options: {
      systemPrompt,
      mcpServers: { [gameServerName]: gameServerInstance as never },
      model,
      permissionMode: "bypassPermissions",
      tools: [],
    },
  })) {
    if (!("type" in message)) continue;
    if (message.type === "assistant" && "message" in message) {
      const msg = message.message as { content: Array<{ type: string; name?: string }> };
      for (const block of msg.content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          called.push(
            block.name.startsWith(mcpPrefix) ? block.name.slice(mcpPrefix.length) : block.name
          );
        }
      }
    } else if (message.type === "result") {
      break;
    }
  }

  return called;
}

function evaluateCase(toolsCalled: string[], c: TriggerCase): boolean {
  const gameToolCalled = toolsCalled.length > 0;
  if (c.should_trigger) {
    if (!gameToolCalled) return false;
    if (c.expected_tool && !toolsCalled.includes(c.expected_tool)) return false;
    return true;
  }
  // Negative: no game tool should be called.
  return !gameToolCalled;
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const { runnerDir, model, runs } = parseArgs(process.argv);
  const configPath = path.join(runnerDir, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`No config.json in runner: ${runnerDir}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { name?: string };
  const gameName = config.name ?? path.basename(runnerDir);

  const evalsDir = path.join(runnerDir, "evals");
  if (!fs.existsSync(evalsDir)) {
    console.error(`No evals/ directory in runner: ${runnerDir}`);
    process.exit(1);
  }
  const evalFiles = fs
    .readdirSync(evalsDir)
    .filter((f) => f.endsWith(".triggers.json"))
    .sort();
  if (evalFiles.length === 0) {
    console.error(`No *.triggers.json files in ${evalsDir}`);
    process.exit(1);
  }

  const { name: serverName, instance: serverInstance } = await loadGameServer(runnerDir);
  const systemPrompt = minimalSystemPrompt(gameName);

  console.log(`\n🎯 Trigger-eval: ${gameName}`);
  console.log(`   Runner: ${runnerDir}`);
  console.log(`   Model:  ${model}   Runs/case: ${runs}`);
  console.log(`   Eval files: ${evalFiles.length}\n`);

  const reports: ToolReport[] = [];

  for (const evalFile of evalFiles) {
    const toolFile = evalFile.replace(/\.triggers\.json$/, "");
    const cases = JSON.parse(
      fs.readFileSync(path.join(evalsDir, evalFile), "utf-8")
    ) as TriggerCase[];

    console.log(`── ${toolFile} (${cases.length} cases) ──`);
    const results: CaseResult[] = [];

    for (const c of cases) {
      let passCount = 0;
      let lastCalls: string[] = [];
      for (let r = 0; r < runs; r++) {
        const calls = await runOneCase(
          c.prompt,
          serverName,
          serverInstance,
          systemPrompt,
          model
        );
        if (evaluateCase(calls, c)) passCount++;
        lastCalls = calls;
      }
      const majorityPassed = passCount > runs / 2;
      const tag = majorityPassed ? "✓" : "✗";
      const trigLabel = c.should_trigger ? "positive" : "negative";
      console.log(
        `  ${tag} [${trigLabel}] ${c.prompt.slice(0, 70)}${c.prompt.length > 70 ? "…" : ""}`
      );
      if (!majorityPassed) {
        console.log(
          `      expected ${c.should_trigger ? (c.expected_tool ?? "any tool") : "no tool"}, got [${lastCalls.join(", ") || "none"}]`
        );
      }
      results.push({
        prompt: c.prompt,
        shouldTrigger: c.should_trigger,
        expectedTool: c.expected_tool,
        toolsCalled: lastCalls,
        passed: majorityPassed,
        note: c.note,
      });
    }
    reports.push({ toolFile, cases: results });
    console.log("");
  }

  // Aggregate
  let totalPos = 0,
    passPos = 0,
    totalNeg = 0,
    passNeg = 0;
  for (const rep of reports) {
    for (const c of rep.cases) {
      if (c.shouldTrigger) {
        totalPos++;
        if (c.passed) passPos++;
      } else {
        totalNeg++;
        if (c.passed) passNeg++;
      }
    }
  }

  console.log("═════ Summary ═════");
  for (const rep of reports) {
    const pos = rep.cases.filter((c) => c.shouldTrigger);
    const neg = rep.cases.filter((c) => !c.shouldTrigger);
    const posPass = pos.filter((c) => c.passed).length;
    const negPass = neg.filter((c) => c.passed).length;
    console.log(
      `  ${rep.toolFile}:  positives ${posPass}/${pos.length} (${pct(posPass, pos.length)})   negatives ${negPass}/${neg.length} (${pct(negPass, neg.length)})`
    );
  }
  console.log(
    `\n  TOTAL:  positives ${passPos}/${totalPos} (${pct(passPos, totalPos)})   negatives ${passNeg}/${totalNeg} (${pct(passNeg, totalNeg)})`
  );

  const posRate = totalPos ? passPos / totalPos : 1;
  const negRate = totalNeg ? passNeg / totalNeg : 1;
  const posOk = posRate >= POSITIVE_THRESHOLD;
  const negOk = negRate >= NEGATIVE_THRESHOLD;
  console.log(
    `\n  Threshold:  positives ≥${POSITIVE_THRESHOLD * 100}% ${posOk ? "✓" : "✗"}    negatives ≥${NEGATIVE_THRESHOLD * 100}% ${negOk ? "✓" : "✗"}\n`
  );

  if (!posOk || !negOk) {
    console.error("Trigger-eval thresholds not met.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("trigger-eval failed:", err);
  process.exit(1);
});
