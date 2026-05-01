/**
 * Standalone harness for running the coherence-auditor against an existing
 * runner directory. Useful for:
 *
 *   - Validating the auditor against a runner without a full regen (faster
 *     iteration cycle when tuning the prompt or schema).
 *
 *   - Running synthetic break tests: edit a manifest's source_ref.quote to
 *     be a fiction passage, run this harness, confirm the auditor flags
 *     `quote_kind: fiction`. Same for tier mismatches in config.json.
 *
 *   - Re-auditing a runner whose regen pre-dates the auditor (the manifest
 *     and prompt were verified inline by the orchestrator at regen time;
 *     this harness produces a structured report after the fact).
 *
 * Invocation:
 *
 *   npx tsx src/meta/run-auditor.ts <runner-dir> <source-path> [--model haiku|sonnet]
 *
 * Example:
 *
 *   npx tsx src/meta/run-auditor.ts runners/goodfellows user-references/goodfellows.md
 *
 * The harness prints the full structured report to stdout and exits with
 * code 0 (ok or warnings_only) or 1 (has_blockers / parse error / agent
 * failure). Useful in CI later if we want regression-test-style auditor
 * runs on canonical runners.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import * as fs from "node:fs";
import { COHERENCE_AUDITOR_PROMPT } from "./prompts/coherence-auditor.js";
import { parseAuditorReport, computeOverallSeverity } from "./auditor.js";

type AgentModel = "sonnet" | "opus" | "haiku";

async function main() {
  const args = process.argv.slice(2);

  let model: AgentModel = "haiku";
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1) {
    const value = args[modelIdx + 1];
    if (value !== "haiku" && value !== "sonnet" && value !== "opus") {
      console.error(`Unknown model: ${value}. Use haiku | sonnet | opus.`);
      process.exit(1);
    }
    model = value;
    args.splice(modelIdx, 2);
  }

  if (args.length < 2) {
    console.error(
      "Usage: npx tsx src/meta/run-auditor.ts <runner-dir> <source-path> [--model haiku|sonnet|opus]"
    );
    console.error(
      "Example: npx tsx src/meta/run-auditor.ts runners/goodfellows user-references/goodfellows.md"
    );
    process.exit(1);
  }

  const runnerDir = path.resolve(args[0]!);
  const sourcePath = path.resolve(args[1]!);

  if (!fs.existsSync(runnerDir)) {
    console.error(`Runner directory not found: ${runnerDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(runnerDir, "tools", "manifest.json"))) {
    console.error(
      `Runner has no tools/manifest.json — auditor needs a manifest. Path: ${runnerDir}`
    );
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    process.exit(1);
  }

  const runnerName = path.basename(runnerDir);

  console.log(`\n🔎 Coherence auditor (standalone)`);
  console.log(`   Runner: ${runnerDir}`);
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Model:  ${model}\n`);

  const prompt = `Audit the runner at "${runnerDir}" against the source at "${sourcePath}".

Runner name: "${runnerName}"

Read the manifest, the source, config.json, server.ts, and the tool / eval directories. Verify all three categories described in your system prompt: source-grounding, manifest consistency, and facilitator coherence.

Return a single JSON object validating against AuditorReportSchema. JSON only — no preamble, no markdown fences.`;

  let streamedText = "";
  let finalResult = "";
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: COHERENCE_AUDITOR_PROMPT,
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      model,
    },
  })) {
    if ("type" in message) {
      if (message.type === "assistant" && "content" in message) {
        for (const block of message.content as Array<{
          type: string;
          text?: string;
        }>) {
          if (block.type === "text" && block.text) {
            streamedText += block.text;
          }
        }
      } else if (message.type === "result") {
        const r = message as { result?: string; subtype?: string };
        finalResult = r.result ?? "";
      }
    }
  }

  // Prefer streamed assistant text; fall back to the result message's
  // synthesized final answer. SDK behaviour can put the whole response in
  // either place depending on how the model ended its turn (tool calls
  // followed by a final text block vs. tool calls then a synthesized
  // result-message answer).
  const lastResponse = streamedText.trim() || finalResult.trim();

  // The auditor returns JSON. Extract it; tolerate accidental fences or preamble.
  const json = extractJsonObject(lastResponse);
  if (!json) {
    console.error("\n❌ Auditor did not return a JSON object.\n");
    console.error(`Streamed assistant text (${streamedText.length} chars):`);
    console.error(streamedText || "<empty>");
    console.error(`\nFinal result message (${finalResult.length} chars):`);
    console.error(finalResult || "<empty>");
    process.exit(1);
  }

  const parsed = parseAuditorReport(json);
  if (!parsed.ok) {
    console.error(`\n❌ Auditor report failed schema validation:\n${parsed.error}\n`);
    console.error(`Raw JSON:\n${json}`);
    process.exit(1);
  }

  const report = parsed.report;

  // Sanity: confirm the auditor's self-classification matches the constituent severities.
  const computed = computeOverallSeverity(report);
  if (computed !== report.overall_severity) {
    console.warn(
      `\n⚠️  Auditor self-classification (${report.overall_severity}) ` +
        `doesn't match computed severity (${computed}). ` +
        `Treating as the more severe of the two.\n`
    );
  }
  const effectiveSeverity =
    severityRank(computed) >= severityRank(report.overall_severity)
      ? computed
      : report.overall_severity;

  console.log("\n=== Auditor Report ===\n");
  console.log(JSON.stringify(report, null, 2));
  console.log("\n=== Summary ===\n");
  console.log(`Severity: ${effectiveSeverity}`);
  console.log(`\n${report.summary}\n`);

  process.exit(effectiveSeverity === "has_blockers" ? 1 : 0);
}

/**
 * Extract a top-level JSON object from a possibly-noisy string. Tolerates
 * accidental ```json fences, leading prose, or trailing commentary. Returns
 * the first balanced { ... } block, or null if none found.
 */
function extractJsonObject(text: string): string | null {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const start = stripped.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}

function severityRank(s: "ok" | "warnings_only" | "has_blockers"): number {
  if (s === "ok") return 0;
  if (s === "warnings_only") return 1;
  return 2;
}

main().catch((err) => {
  console.error("Auditor harness failed:", err);
  process.exit(1);
});
