/**
 * Library entry point for invoking the coherence-auditor subagent against
 * a runner directory. Used by:
 *
 *   - The standalone CLI harness (`src/meta/run-auditor.ts`).
 *   - The auditor unit-test suite (`tests/auditor-fixtures/`), which calls
 *     this function directly from vitest tests rather than shelling out.
 *
 * Returns a discriminated union: `{ ok: true, report }` on success, or
 * `{ ok: false, error, raw? }` on schema-validation or extraction failure.
 * Callers decide whether to throw, log, or surface the error.
 *
 * Why a library function:
 * - The CLI's behaviour (print + exit) doesn't compose with vitest, which
 *   wants to assert on a typed return value.
 * - Future verification subagents (continuity-checker, corpus-distribution
 *   auditor) follow the same query()-then-parse pattern; this is the place
 *   to factor any shared invocation logic.
 *
 * The function is intentionally thin: it owns the SDK invocation, the
 * dual-channel response capture (streamed assistant text vs. final result
 * message), and the JSON extraction + schema validation. Higher-level
 * concerns (printing, exit codes, severity-based gating) belong to the
 * CLI / test wrappers.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { COHERENCE_AUDITOR_PROMPT } from "./prompts/coherence-auditor.js";
import {
  parseAuditorReport,
  type AuditorReport,
} from "./auditor.js";

export type AgentModel = "sonnet" | "opus" | "haiku";

export interface RunAuditorOptions {
  /** Absolute or cwd-relative path to the runner directory to audit. */
  runnerDir: string;
  /** Absolute or cwd-relative path to the source file or directory. */
  sourcePath: string;
  /** Auditor model. Defaults to Haiku — the auditor is mechanical. */
  model?: AgentModel;
  /**
   * Optional override for the runner name passed to the auditor. Defaults
   * to the basename of `runnerDir`. Useful for fixture tests where the
   * directory is `tests/auditor-fixtures/clean/` but the manifest's
   * `game_name` (and the auditor's own `runner_name` field) should be
   * something more readable.
   */
  runnerName?: string;
}

export type RunAuditorResult =
  | { ok: true; report: AuditorReport; raw: string }
  | { ok: false; error: string; raw: string };

/**
 * Invoke the auditor against a runner directory + source path. Returns
 * the parsed report on success, or a structured error on failure.
 *
 * The function does not throw on schema validation failure — instead it
 * returns `{ ok: false, error, raw }` so callers can decide between
 * surfacing the diagnostic vs. retrying.
 */
export async function runAuditor(
  opts: RunAuditorOptions
): Promise<RunAuditorResult> {
  const { runnerDir, sourcePath, model = "haiku" } = opts;
  const runnerName = opts.runnerName ?? basename(runnerDir);

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
        const r = message as { result?: string };
        finalResult = r.result ?? "";
      }
    }
  }

  // Prefer streamed assistant text; fall back to the result message's
  // synthesized final answer. SDK behaviour can put the whole response in
  // either place depending on how the model ended its turn.
  const raw = streamedText.trim() || finalResult.trim();

  const json = extractJsonObject(raw);
  if (!json) {
    return {
      ok: false,
      error:
        "Auditor did not return a JSON object. " +
        `Streamed text: ${streamedText.length} chars; ` +
        `final result: ${finalResult.length} chars.`,
      raw,
    };
  }

  const parsed = parseAuditorReport(json);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw: json };
  }

  return { ok: true, report: parsed.report, raw: json };
}

/**
 * Extract a top-level JSON object from a possibly-noisy string. Tolerates
 * accidental ```json fences, leading prose, or trailing commentary.
 * Returns the first balanced { ... } block, or null if none found.
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

/**
 * Cross-platform `path.basename` without importing `node:path` for one use.
 * The runner-name override option means most callers don't need this, but
 * we still default to the directory name when no override is given.
 */
function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const lastSep = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return lastSep === -1 ? norm : norm.slice(lastSep + 1);
}
