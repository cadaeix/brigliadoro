/**
 * Standalone CLI for running the coherence-auditor against an existing
 * runner directory. Useful for:
 *
 *   - Validating the auditor against a runner without a full regen (faster
 *     iteration cycle when tuning the prompt or schema).
 *
 *   - Running synthetic break tests: edit a manifest's source_ref.quote to
 *     be a fiction passage, run this CLI, confirm the auditor flags
 *     `quote_kind: fiction`. Same for tier mismatches in config.json.
 *
 *   - Re-auditing a runner whose regen pre-dates the auditor (the manifest
 *     and prompt were verified inline by the orchestrator at regen time;
 *     this CLI produces a structured report after the fact).
 *
 * Invocation:
 *
 *   npx tsx src/meta/run-auditor.ts <runner-dir> <source-path> [--model haiku|sonnet|opus]
 *
 * Example:
 *
 *   npx tsx src/meta/run-auditor.ts runners/goodfellows user-references/goodfellows.md
 *
 * The CLI prints the full structured report to stdout and exits with code
 * 0 (ok or warnings_only) or 1 (has_blockers / parse error / agent
 * failure).
 *
 * The auditor invocation logic itself lives in `auditor-runner.ts` so the
 * vitest unit-test suite can call it directly without shelling out.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runAuditor, type AgentModel } from "./auditor-runner.js";
import { computeOverallSeverity } from "./auditor.js";

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

  console.log(`\n🔎 Coherence auditor (standalone)`);
  console.log(`   Runner: ${runnerDir}`);
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Model:  ${model}\n`);

  const result = await runAuditor({ runnerDir, sourcePath, model });

  if (!result.ok) {
    console.error(`\n❌ Auditor invocation failed:\n${result.error}\n`);
    if (result.raw) {
      console.error(`Raw response:\n${result.raw}\n`);
    }
    process.exit(1);
  }

  const report = result.report;

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

function severityRank(s: "ok" | "warnings_only" | "has_blockers"): number {
  if (s === "ok") return 0;
  if (s === "warnings_only") return 1;
  return 2;
}

main().catch((err) => {
  console.error("Auditor CLI failed:", err);
  process.exit(1);
});
